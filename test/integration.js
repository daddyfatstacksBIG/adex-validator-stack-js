#!/usr/bin/env node
const tape = require('tape')
const fetch = require('node-fetch')
const { Channel, MerkleTree } = require('adex-protocol-eth/js')

// those are hardcoded in ./test/prep-db
const leaderUrl = 'http://localhost:8005'
const followerUrl = 'http://localhost:8006'
const authToken = 'x8c9v1b2'
const channelId = 'awesomeTestChannel'
const defaultPubName = 'myAwesomePublisher'

tape('/channel/list', function(t) {
	fetch(`${leaderUrl}/channel/list`)
	.then(res => res.json())
	.then(function(resp) {
		t.ok(Array.isArray(resp.channels), 'resp.channels is an array')
		t.equal(resp.channels.length, 1, 'resp.channels is the right len')
		t.equal(resp.channels[0].status, 'live', 'channel is the right status')
		t.end()
	})
	.catch(err => t.fail(err))
	// @TODO: test channel list filters if there are any
})

tape('/channel/{id}/tree', function(t) {
	fetch(`${leaderUrl}/channel/${channelId}/tree`)
	.then(res => res.json())
	.then(function(resp) {
		t.ok(resp.channel, 'has resp.channel')
		t.equal(resp.channel.status, 'live', 'channel has right status')
		t.deepEqual(resp.balances, {}, 'channel has balances')
		t.equal(new Date(resp.lastEvAggr).getTime(0), 0, 'lastEvAggr is 0')
		t.end()
	})
	.catch(err => t.fail(err))
})

tape('submit events and ensure they are accounted for', function(t) {
	const evBody = JSON.stringify({
		events: genImpressions(3).events
			.concat(genImpressions(2, 'anotherPublisher').events)
	})
	const expectedBal = '3'

	let channel
	let tree

	Promise.all(
		[leaderUrl, followerUrl].map(url => postEvents(url, channelId, evBody))
	)
	// @TODO: this number should be auto calibrated *cough* scientifically according to the event aggregate times and validator worker times
	// for that purpose, the following constants should be accessible from here
	// validatorWorker snooze time: 10s, eventAggregator service debounce: 10s
	// even for the balance tree, we need to wait for both, cause the producer tick updates it
	.then(() => wait(22000))
	.then(function() {
		return fetch(`${leaderUrl}/channel/${channelId}/tree`)
		.then(res => res.json())
	})
	.then(function(resp) {
		channel = resp.channel
		tree = resp.balances
		t.equal(resp.balances[defaultPubName], expectedBal, 'balances is right')
		// We will check the leader, cause this means this happened:
		// the NewState was generated, sent to the follower,
		// who generated ApproveState and sent back to the leader
		// first wait though, as we need the follower to discover they have an event to approve
		return wait(11000).then(function() {
			return fetch(`${leaderUrl}/channel/${channelId}/validator-messages`)
			.then(res => res.json())
		})
	})
	.then(function(resp) {
		const msgs = resp.validatorMessages
		t.ok(Array.isArray(msgs), 'has validatorMessages')

		// ensure NewState is in order
		const lastNew = msgs.find(x => x.msg.type === 'NewState')
		t.ok(lastNew, 'has NewState')
		t.equal(lastNew.from, channel.validators[0], 'NewState: is by the leader')
		t.equal(lastNew.msg.balances[defaultPubName], expectedBal, 'NewState: balances is right')
		t.ok(typeof(lastNew.msg.stateRoot) === 'string' && lastNew.msg.stateRoot.length === 64, 'NewState: stateRoot is sane')
		t.equal(lastNew.msg.signature, getDummySig(lastNew.msg.stateRoot, lastNew.from), 'NewState: signature is sane')
		t.deepEqual(lastNew.msg.balances, tree, 'NewState: balances is the same as the one in /tree')

		// Ensure ApproveState is in order
		const lastApprove = msgs.find(x => x.msg.type === 'ApproveState')
		t.ok(lastApprove, 'has ApproveState')
		t.equal(lastApprove.from, channel.validators[1], 'ApproveState: is by the follower')
		t.ok(typeof(lastApprove.msg.stateRoot) === 'string' && lastApprove.msg.stateRoot.length === 64, 'ApproveState: stateRoot is sane')
		t.equal(lastApprove.msg.signature, getDummySig(lastApprove.msg.stateRoot, lastApprove.from), 'ApproveState: signature is sane')
		t.equal(lastNew.msg.stateRoot, lastApprove.msg.stateRoot, 'stateRoot is the same between latest NewState and ApproveState')
		t.equal(lastApprove.msg.health, 'HEALTHY', 'ApproveState: health value is HEALTHY')

		// Check inclusion proofs of the balance
		const allLeafs = Object.keys(tree).map(k => Channel.getBalanceLeaf(k, tree[k]))
		const mTree = new MerkleTree(allLeafs)
		const stateRoot = lastNew.msg.stateRoot
		t.equals(mTree.getRoot().toString('hex'), stateRoot, 'stateRoot matches merkle tree root')

		// this is a bit out of scope, looks like a test of the MerkleTree lib, 
		// but better be safe than sorry
		const leaf = Channel.getBalanceLeaf(defaultPubName, expectedBal)
		const proof = mTree.proof(leaf)
		t.ok(mTree.verify(proof, leaf), 'balance leaf is in stateRoot')

		t.end()
	})
	.catch(err => t.fail(err))
})

tape('health works correctly', function(t) {
	const toFollower = 8
	const toLeader = 1
	const diff = toFollower-toLeader
	Promise.all(
		[leaderUrl, followerUrl].map(url =>
			postEvents(url, channelId,
				JSON.stringify(genImpressions(url == followerUrl ? toFollower : toLeader))
			)
		)
	)
	//postEvents(followerUrl, channelId, JSON.stringify(genImpressions(4)))
	// wait for the events to be aggregated and new states to be issued
	.then(() => wait(21000))
	.then(function() {
		// get the latest state
		return fetch(`${followerUrl}/channel/${channelId}/validator-messages`)
		.then(res => res.json())
	})
	.then(function(resp) {
		const lastApprove = resp.validatorMessages.find(x => x.msg.type === 'ApproveState')
		// @TODO: Should we assert balances numbers?
		t.equal(lastApprove.msg.health, 'UNHEALTHY', 'channel is registered as unhealthy')

		// send events to the leader so it catches up
		return postEvents(leaderUrl, channelId, JSON.stringify(genImpressions(diff)))
	})
	.then(() => wait(21000))
	.then(function() {
		return fetch(`${followerUrl}/channel/${channelId}/validator-messages`)
		.then(res => res.json())
	})
	.then(function(resp) {
		const lastApprove = resp.validatorMessages.find(x => x.msg.type === 'ApproveState')
		t.equal(lastApprove.msg.health, 'HEALTHY', 'channel is registered as healthy')
		t.end()
	})
})

tape('cannot exceed channel deposit', function(t) {
	fetch(`${leaderUrl}/channel/${channelId}/status`)
	.then(res => res.json())
	.then(function(resp) {
		// 1 event pays 1 token for now
		// @TODO make this work with a more complex model
		const evCount = resp.channel.depositAmount + 1
		return Promise.all([leaderUrl, followerUrl].map(url =>
			postEvents(url, channelId,
				JSON.stringify(genImpressions(evCount))
			)
		))
	})
	.then(() => wait(21000))
	.then(function() {
		return fetch(`${leaderUrl}/channel/${channelId}/tree`)
		.then(res => res.json())
	})
	.then(function(resp) {
		t.equal(resp.balances[defaultPubName], '1000', 'balance does not exceed the deposit')
		// @TODO state changed to exhausted, unable to take any more events
		t.end()
	})
})

function postEvents(url, channelId, body) {
	return fetch(`${url}/channel/${channelId}/events`, {
		method: 'POST',
		headers: {
			'authorization': `Bearer ${authToken}`,
			'content-type': 'application/json',
		},
		body: body
	})
}

function genImpressions(n, pubName) {
	const events = []
	for (let i=0; i<n; i++) events.push({
		type: 'IMPRESSION',
		publisher: pubName || defaultPubName,
	})
	return { events }
}

function getDummySig(hash, from) {
	return `Dummy adapter signature for ${hash} by ${from}`
}

function wait(ms) {
	return new Promise((resolve, reject) => setTimeout(resolve, ms))
}

// @TODO full sentry tests
// @TODO can't submit states that aren't signed and valid (everything re msg propagation); perhaps forge invalid states and try to submit directly by POST /channel/:id/validator-messages
// @TODO can't trick with negative values (again, by POST validator-messages)
// @TODO consider separate tests for when/if/how /tree is updated? or unit tests for the event aggregator
