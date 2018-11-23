function sessionFromToken(token) {
	console.log('sessionFromToken TODO', token)
	// @TODO
	return Promise.resolve(null)
}

function whoami() {
	// @TODO
	if (!process.env.TEST_IDENTITY) {
		console.error('ethereum adapter unimplemented! please run with TEST_IDENTITY=awesomeLeader (or awesomeFollower)')
		process.exit(1)
	}
	return process.env.TEST_IDENTITY
}

module.exports = { sessionFromToken, whoami }
