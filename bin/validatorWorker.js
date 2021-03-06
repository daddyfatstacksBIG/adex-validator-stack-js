#!/usr/bin/env node
const assert = require('assert')
const yargs = require('yargs')
const fetch = require('node-fetch')
const cfg = require('../cfg')
const adapters = require('../adapters')
const leader = require('../services/validatorWorker/leader')
const follower = require('../services/validatorWorker/follower')
const SentryInterface = require('../services/validatorWorker/lib/sentryInterface')
const logger = require('../services/logger')('validatorWorker')

const { argv } = yargs
	.usage('Usage $0 [options]')
	.describe('adapter', 'the adapter for authentication and signing')
	.choices('adapter', Object.keys(adapters))
	.default('adapter', 'ethereum')
	.describe('keystoreFile', 'path to JSON Ethereum keystore file')
	.describe('dummyIdentity', 'the identity to use with the dummy adapter')
	.describe('sentryUrl', 'the URL to the sentry used for listing channels')
	.default('sentryUrl', 'http://127.0.0.1:8005')
	.boolean('singleTick')
	.describe('singleTick', 'run a single tick and exit')
	.demandOption(['adapter', 'sentryUrl'])

const adapter = new adapters[argv.adapter].Adapter(
	{
		dummyIdentity: argv.dummyIdentity,
		keystoreFile: argv.keystoreFile,
		keystorePwd: process.env.KEYSTORE_PWD
	},
	cfg
)

const tickTimeout = cfg.VALIDATOR_TICK_TIMEOUT || 5000

adapter
	.init()
	.then(() => adapter.unlock())
	.then(function() {
		if (argv.singleTick) {
			allChannelsTick().then(() => process.exit(0))
		} else {
			loopChannels()
		}
	})
	.catch(function(err) {
		// eslint-disable-next-line no-console
		logger.error(err)
		process.exit(1)
	})

function getChannels(pageNumber) {
	const page = pageNumber ? `&page=${pageNumber}` : null
	const defaultUrl = `${argv.sentryUrl}/channel/list?validator=${adapter.whoami()}`
	const url = page ? `${defaultUrl}${page}` : defaultUrl

	return fetch(url, {
		timeout: cfg.LIST_TIMEOUT
	}).then(res => res.json())
}

async function allChannelsTick(currentPage) {
	// get page 0
	const { channels, totalPages } = await getChannels(currentPage)
	// start from page 1 to end
	const pages = range(1, totalPages - 1)

	const otherChannelsResp = await Promise.all(pages.map(getChannels))
	const otherChannels = otherChannelsResp.map(r => r.channels).reduce((a, b) => a.concat(b), [])

	const allChannels = channels.concat(otherChannels)
	const allResults = await Promise.all(allChannels.map(validatorTick)).catch(e =>
		logger.error('allChannelsTick failed', e)
	)

	logPostChannelsTick(allResults)
}

function range(start, end) {
	const arr = []
	for (let i = start; i <= end; i += 1) {
		arr.push(i)
	}
	return arr
}

function loopChannels() {
	Promise.all([allChannelsTick(), wait(cfg.WAIT_TIME)]).then(loopChannels)
}

function validatorTick(channel) {
	const validatorIdx = channel.spec.validators.findIndex(v => v.id === adapter.whoami())
	assert.ok(validatorIdx !== -1, 'validatorTick: processing a channel where we are not validating')

	const isLeader = validatorIdx === 0
	const tick = isLeader ? leader.tick : follower.tick
	const iface = new SentryInterface(adapter, channel)
	return (
		Promise.race([tick(adapter, iface, channel), timeout(`tick for ${channel.id} timed out`)])
			// eslint-disable-next-line no-console
			.catch(e => console.error(`${channel.id} tick failed`, e))
	)
}

function wait(ms) {
	return new Promise(resolve => setTimeout(resolve, ms))
}

function timeout(msg) {
	return new Promise((_, reject) => setTimeout(() => reject(new Error(msg)), tickTimeout))
}

function logPostChannelsTick(channels) {
	logger.info(`processed ${channels.length} channels`)
	if (channels.length >= cfg.MAX_CHANNELS) {
		logger.info(`WARNING: channel limit cfg.MAX_CHANNELS=${cfg.MAX_CHANNELS} reached`)
	}
}
