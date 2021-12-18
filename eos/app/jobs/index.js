require("dotenv").config();
const MongoClient = require('mongodb').MongoClient;
const db = require("../../config/db");
const logger = require("../../config/winston-job");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const fs = require("fs");

const depositCheckerJob = require('./deposit_checker_job');
const withdrawCheckerJob = require('./withdraw_checker_job');
const transactionCheckerJob = require('./transaction_checker_job');
const resendTransactionJob = require('./resend_transaction_job');
const gasPriceJob = require('./gas_price_job');
const currencyRateJob = require('./currency_rate_job');
const coinPriceJob = require('./coin_price_job');

const base = require("../utils/base_utils");

let args;
if (process.env.SEPARATE_JOB === "N") {
	logger.info("job index started in child process");
	global.APP_HASH = process.argv[2];
	global.SHARED_KEY = process.argv[3];
} else {
	args = require('yargs')
		.options({
			'password': {
				alias: 'p',
				describe: 'password to run the index',
				demandOption: true,
				type: "string",
				nargs: 1
			}
		})
		.help()
		.argv
};

MongoClient.connect(db.url, async (err, database) => {
	if (err) {
		logger.error("job index: Error connecting to database " + err);
		return;
	}
	const walletDb = database.db(db.name);

	// load what's needed into the memory
	if (process.env.SEPARATE_JOB === "Y") {
		await verifyPass(walletDb);
	}
	
	// load base
	await base.loadValue(walletDb, "asset");
	
	logger.info("job process connected to db successfully");
	logger.info("=== Starting up batch jobs. ===");

	// check if the deposit job is enabled 
	if (process.env.RUN_DEPOSIT_JOB === "Y")
		depositCheckerJob.start(walletDb);
	// check if the withdraw job is enabled
	if (process.env.RUN_WITHDRAW_JOB === "Y")
		withdrawCheckerJob.start(walletDb);

	// transaction checker for checking if transactions
	// submitted have been confirmed or not
	transactionCheckerJob.start(walletDb);
	// resend transaction job for resending transactions
	// to the server
	resendTransactionJob.start(walletDb);
	// query for the price of gas (eth)
	if (process.env.RUN_GAS_JOB === "Y")
		gasPriceJob.start(walletDb);
	// query for the rates of currencies
	if (process.env.RUN_CURRENCY_JOB === "Y")
		currencyRateJob.start(walletDb);
	// get real time coin prices
	if (process.env.RUN_COIN_JOB === "Y")
		coinPriceJob.start(walletDb);
});

const verifyPass = async (walletDb) => {
	const password = args.password;
	const dbPass = await walletDb.collection("base").findOne({
		name: "appPass"
	});
	if (dbPass) {
		// check if the passwords match
		if (bcrypt.compareSync(password, dbPass.value)) {
			logger.info("Engine startup success");
		} else {
			logger.debug("Passwords don't match.");
			console.log("Password doesn't match stored password. Exiting.");
			process.exit(1);
		}
	} else {
		console.log("Creating a new password.");
		logger.debug("Generating password hash.");
		let hash = bcrypt.hashSync(password, 10);
		walletDb.collection("base").insert({
			name: "appPass",
			value: hash
		});
	}
	// store the password hash in a global variable
	global.APP_HASH = crypto.createHash('md5').update(password).digest("hex");

	// load the API key
	let sharedKey = fs.readFileSync("config/key.cfg", 'utf8');
	// decrypt the shared key
	const encoded = sharedKey.match(/ENC\((.*)\)/); 
	if(encoded) {
		sharedKey = secUtil.decryptSecret(encoded[1]);
	}
	global.SHARED_KEY = sharedKey;
}