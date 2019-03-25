#!/usr/bin/env node

const tape = require('tape')
const fetch = require('node-fetch')
const { postEvents } = require('./lib')

// const cfg = require('../cfg')
const dummyVals = require('./prep-db/mongo')

const leaderUrl = dummyVals.channel.spec.validators[0].url
const followerUrl = dummyVals.channel.spec.validators[1].url
// const defaultPubName = dummyVals.ids.publisher
const expectedDepositAmnt = dummyVals.channel.depositAmount

tape('/channel/list', function(t) {
	fetch(`${leaderUrl}/channel/list`)
		.then(res => res.json())
		.then(function(resp) {
			t.ok(Array.isArray(resp.channels), 'resp.channels is an array')
			t.equal(resp.channels.length, 1, 'resp.channels is the right len')
			t.end()
		})
		.catch(err => t.fail(err))
	// @TODO: test channel list filters if there are any
})

tape('/channel/{id}/{status,tree}: non existant channel', function(t) {
	Promise.all(
		['status', 'tree'].map(path =>
			fetch(`${leaderUrl}/channel/xxxtentacion/${path}`).then(function(res) {
				t.equal(res.status, 404, 'status should be 404')
			})
		)
	)
		.then(() => t.end())
		.catch(err => t.fail(err))
})

tape('POST /channel/{id}/events: non existant channel', function(t) {
	return postEvents(leaderUrl, 'xxxtentacion', []).then(function(resp) {
		t.equal(resp.status, 404, 'status should be 404')
		t.end()
	})
})

tape('/channel/{id}/status', function(t) {
	fetch(`${leaderUrl}/channel/${dummyVals.channel.id}/tree`)
		.then(res => res.json())
		.then(function(resp) {
			t.ok(resp.channel, 'has resp.channel')
			t.equal(resp.channel.depositAmount, expectedDepositAmnt, 'depositAmount is as expected')
			t.end()
		})
		.catch(err => t.fail(err))
})

tape('/channel/{id}/tree', function(t) {
	fetch(`${leaderUrl}/channel/${dummyVals.channel.id}/tree`)
		.then(res => res.json())
		.then(function(resp) {
			t.ok(resp.channel, 'has resp.channel')
			t.deepEqual(resp.balances, {}, 'channel has balances')
			t.equal(new Date(resp.lastEvAggr).getTime(0), 0, 'lastEvAggr is 0')
			t.end()
		})
		.catch(err => t.fail(err))
})

tape('POST /channel/{id}/validator-messages: malformed messages (leader -> follower)', function(t) {
	Promise.all(
		[
			null,
			{ type: 1 },
			{ type: 'NewState' },
			{ type: 'NewState', balances: 'iamobject' },
			{ type: 'ApproveState', stateRoot: 'notlongenough', signature: 'something' }
		].map(msg =>
			fetch(`${followerUrl}/channel/${dummyVals.channel.id}/validator-messages`, {
				method: 'POST',
				headers: {
					authorization: `Bearer ${dummyVals.auth.leader}`,
					'content-type': 'application/json'
				},
				body: JSON.stringify({ messages: [msg] })
			}).then(function(resp) {
				t.equal(resp.status, 400, 'status must be BadRequest')
			})
		)
	)
		.then(() => t.end())
		.catch(err => t.fail(err))
})

tape('POST /channel/{id}/events: malformed events', function(t) {
	Promise.all(
		[null, { type: 1 }, { type: null }].map(ev =>
			fetch(`${leaderUrl}/channel/${dummyVals.channel.id}/events`, {
				method: 'POST',
				headers: {
					authorization: `Bearer ${dummyVals.auth.user}`,
					'content-type': 'application/json'
				},
				body: JSON.stringify({ events: [ev] })
			}).then(function(resp) {
				t.equal(resp.status, 400, 'status is BadRequest')
			})
		)
	)
		.then(() => t.end())
		.catch(err => t.fail(err))
})

tape('POST /channel/{id}/{events,validator-messages}: wrong authentication', function(t) {
	Promise.all(
		['events', 'validator-messages'].map(path =>
			fetch(`${leaderUrl}/channel/${dummyVals.channel.id}/${path}`, {
				method: 'POST',
				headers: {
					authorization: `Bearer WRONG AUTH`,
					'content-type': 'application/json'
				},
				body: JSON.stringify({ messages: [] })
			}).then(function(resp) {
				t.equal(resp.status, 401, 'status must be Unauthorized')
			})
		)
	)
		.then(() => t.end())
		.catch(err => t.fail(err))
})

tape('POST /channel: create channel', function(t) {
	const body = {
		id: 'awesomeTestChannel',
		depositAsset: 'DAI',
		depositAmount: 1000,
		validators: ['awesomeLeader', 'awesomeFollower'],
		spec: {
			validators: [
				{ id: 'awesomeLeader', url: 'http://localhost:8005', fee: 100 },
				{ id: 'awesomeFollower', url: 'http://localhost:8006', fee: 100 }
			]
		},
		watcher: {
			ethereum: {
				contract: '0x8A63b2a4AE1A8c3768d020E464B5a83461C260f2'
			}
		}
	}

	fetch(`${followerUrl}/channel`, {
		method: 'POST',
		headers: {
			authorization: `Bearer ${dummyVals.auth.leader}`,
			'content-type': 'application/json'
		},
		body: JSON.stringify(body)
	})
		.then(res => res.json())
		.then(function(resp) {
			t.equal(resp.success, true, 'Successfully created campaign')
		})
		.then(() => t.end())
		.catch(err => t.fail(err))
})

tape('POST /channel: should not create campaign', function(t) {
	Promise.all(
		[
			{
				depositAsset: 'DAI',
				depositAmount: 1000,
				validators: ['awesomeLeader', 'awesomeFollower'],
				spec: {
					validators: [
						{ id: 'awesomeLeader', url: 'http://localhost:8005', fee: 100 },
						{ id: 'awesomeFollower', url: 'http://localhost:8006', fee: 100 }
					]
				}
			},
			{
				id: 'awesomeTestChannel'
			},
			{
				depositAsset: 'DAI',
				depositAmount: 1000,
				validators: ['awesomeFollower'],
				spec: {
					validators: [
						{ id: 'awesomeLeader', url: 'http://localhost:8005' },
						{ id: 'awesomeFollower', url: 'http://localhost:8006' }
					]
				}
			}
		].map(function(body) {
			return fetch(`${followerUrl}/channel`, {
				method: 'POST',
				headers: {
					authorization: `Bearer ${dummyVals.auth.leader}`,
					'content-type': 'application/json'
				},
				body: JSON.stringify(body)
			}).then(function(resp) {
				t.equal(resp.status, 400, 'status must be BadRequest')
			})
		})
	)
		.then(() => t.end())
		.catch(err => t.fail(err))
})
