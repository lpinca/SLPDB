import * as dotenv from 'dotenv';
dotenv.config()

import { Config } from './config';
import { Info } from './info';
import { Bit } from './bit';
import { Db } from './db';

const db = new Db();
const bit = new Bit();

const daemon = {
	run: async function() {
		// 1. Initialize
		await db.init();
		await bit.init(db);

		// 2. Bootstrap actions depending on first time
		const lastSynchronized = await Info.checkpoint()

		console.time('Indexing Keys')
		if (lastSynchronized === Config.core.from) {
			// First time. Try indexing
			console.log('Indexing...', new Date())
			await db.blockindex()
		}
		console.timeEnd('Indexing Keys')

		if (lastSynchronized !== Config.core.from) {
		// Resume
		// Rewind one step and start
		// so that it can recover even in cases
		// where the last run crashed during index
		// and the block was not indexed completely.
		//console.log('Resuming...')
		await util.fix(lastSynchronized-1)
		}

		// 3. Start synchronizing
		console.log('Synchronizing...', new Date())
		console.time('Initial Sync')
		await bit.run()
		console.timeEnd('Initial Sync')

		// 4. Start listening
		bit.listen()
	}
}

const util = {
	run: async function() {
		await db.init()
		let cmd = process.argv[2]
		if (cmd === 'fix') {
			let from
			if (process.argv.length > 3) {
				from = parseInt(process.argv[3])
			} else {
				from = await Info.checkpoint()
			}
			await util.fix(from)
			process.exit()
		} else if (cmd === 'reset') {
			await db.blockreset()
			await db.mempoolreset()
			await Info.deleteTip()
		process.exit()
		} else if (cmd === 'index') {
			await db.blockindex()
			process.exit()
		}
	},
	fix: async function(from: any) {
		console.log('Restarting from index ', from)
		console.time('replace')
		await bit.init(db)
		let content = await bit.crawl(from)
		await db.blockreplace(content, from)
		console.log('Block', from, 'fixed.')
		await Info.updateTip(from)
		console.log('[finished]')
		console.timeEnd('replace')
	}
}

const start = async function() {
	if (process.argv.length > 2) {
		util.run()
	} else {
		daemon.run()
	}
}

start()