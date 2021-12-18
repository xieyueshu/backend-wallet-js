const MongoClient = require('mongodb').MongoClient;
const bcrypt = require("bcrypt");
const readline = require("readline");
const fs = require("fs");
// load environmental values
const dotenv = require("dotenv");

const db = require("../config/db");
const logger = require("../config/winston");
const defaults = require("./install/defaults.js");

const rl = readline.createInterface(process.stdin, process.stdout);
console.log(`Running Update . . . . . `);
console.log(`DB: ${db.name}`);

var question = function (q) {
	return new Promise((res, rej) => {
		rl.question(q, answer => {
			res(answer);
		})
	});
};

MongoClient.connect(db.url, async (err, database) => {
	if (err) return console.log(err);

	const walletDb = database.db(db.name);
	const base = defaults.base;
	const baseDb = (await walletDb.collection("base").find().toArray()).map(b=>b.name);
	const missingBase = base.filter(b => !baseDb.includes(b.name));
	console.log(`New settings to add: ${JSON.stringify(missingBase)}`);
	
	const perms = defaults.permission;
	const permsDb = (await walletDb.collection("permission").find().toArray()).map(p => p.code);
	const missingPerms = perms.filter(p => !permsDb.includes(p.code));
	console.log(`New permissions to add: ${JSON.stringify(missingPerms)}`);

	if(missingBase.length || missingPerms.length) {
		const cont = await question("Insert missing records (answer Y to insert)? ");
		if(cont.trim().toUpperCase() === "Y") {
			if(missingBase.length)
			await walletDb.collection("base").insert(missingBase);
			if(missingPerms.length)
				await walletDb.collection("permission").insert(missingPerms);
			console.log("Database updated!");
		}
	}

	console.log("\nLoading .env updates . . . . ");
	const newEnv = dotenv.config({ path:".env.example" }).parsed;
	const currentEnv = dotenv.config().parsed;
	const missingKeys = Object.keys(newEnv).filter(k => currentEnv[k] === undefined);
	const updatedKeys = Object.keys(currentEnv).filter(k => newEnv[k] !== "" && newEnv[k] !== currentEnv[k]);
	console.log(`Number of missing .env variables: ${missingKeys.length}`);
	console.log(`Number of updated .env variables: ${updatedKeys.length}`);

	let envWrite = false;
	if (missingKeys.length){
		fs.writeFileSync("env_update.txt", "=== MISSING VARIABLES ===\n");
		missingKeys.forEach(k=> fs.appendFileSync("env_update.txt", `${k}=${newEnv[k]}\n`));
		fs.appendFileSync("env_update.txt", "\n\n");
		envWrite = true;
	}
	if (updatedKeys.length){
		if(envWrite) {
			fs.appendFileSync("env_update.txt", "=== UPDATED VARIABLES ===\n");
		} else {
			fs.writeFileSync("env_update.txt", "=== UPDATED VARIABLES ===\n");
		}
		updatedKeys.forEach(k=> fs.appendFileSync("env_update.txt", `${k}=${newEnv[k]}\n`));
		envWrite = true;
	}
	if(envWrite) {
		fs.appendFileSync("env_update.txt", `\nFile generated on: ${new Date().toLocaleString()}` );
		console.log("Created env_update.txt file in the same folder!");
	}
	
	console.log("\n\nCompleted update script!");
	process.exit(0);
});