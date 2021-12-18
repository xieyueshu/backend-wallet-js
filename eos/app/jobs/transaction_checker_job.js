const Web3 = require("web3");
const BigNumber = require("bignumber.js");
const moment = require("moment");

const securityUtil = require("../utils/security_utils");
const etherUtil = require("../utils/eth_utils");
const amtUtil = require("../utils/amt_utils");
const btcUtil = require("../utils/btc_utils");
const eosUtil = require("../utils/eos_utils");
const httpUtil = require("../utils/http_utils");
const dbUtil = require("../utils/db_utils");
const logger = require("../../config/winston-job");

var isRunning = false;

async function transactionChecker(db) {
	if (!isRunning) {
		isRunning = true;
		await work(db);
		isRunning = false;
	} else {
		logger.debug("Skipped transaction_checker_job run due to ongoing operation");
	}
}

/**
 * Job that checks for transactions that have been created and published to the blockchain
 * and marks them as completed or failed, depending on their status on
 * the blockchain. Also resends transactions if the transaction has failed 
 * (and if failed transactions are configured to be re-sent).
 */
const work = async (db) => {
	logger.debug("transaction_checker_job - running");
	try {
		let txns = await db.collection("transaction").find({
			status: "P"
		}).sort({
			sender: 1,
			nonce: 1
		}).toArray();

		
		let web3 = null, ethBlockNum; 
		if (process.env.CHAIN_SUPPORT.includes("ETH")) {
			web3 = new Web3(new Web3.providers.HttpProvider(process.env.NODE_ETH_NETWORK));
			// get the latest block number
			ethBlockNum = await etherUtil.getLatestBlock(web3);
		}
		for (let i = 0; i < txns.length; i++) {
			let txn = txns[i];
			if (!txn.txnHash)
				continue; //skip the transaction if the hash is blank
			let isComplete;
			if (txn.coinType === "AMTC" || txn.coinType === "ETH")
				isComplete = await checkEthTxn(db, web3, ethBlockNum, txn);
			else if (txn.coinType === "AMT" || txn.coinType === "AMT_A")
				isComplete = await checkAmtTxn(db, txn);
			else if (txn.coinType === "BTC" || txn.coinType === "OMNI")
				isComplete = await checkBtcTxn(db, txn);
			else if (await eosUtil.isCoinName(db, txn.coinType))
				isComplete = await checkEosTxn(db, txn);
		}

	} catch (err) {
		logger.error("transaction_checker_job - error: " + err.stack);
	}

}

const checkEthTxn = async (db, web3, blockNum, txn) => {
	const currTime = new Date().getTime();
	let receipt = await etherUtil.getReceipt(web3, txn.txnHash);
	// if the transaction has a receipt, it is no longer pending
	if (receipt) {
		// check the number of block confirmations
		if (blockNum - receipt.blockNumber >= parseInt(process.env.ETH_CONFIRMATION_COUNT)) {
			if (parseInt(receipt.status, 16) === 1) {
				logger.info("transaction_checker_job - Found successful transaction: " + txn.txnHash);
				// include the record in those to be marked as "successful"
				txn.gas = receipt.gasUsed;
				txn.blockNumber = receipt.blockNumber;
				txn.timeStamp = (await etherUtil.getBlock(web3, receipt.blockNumber)).timestamp;
				db.collection('transaction').findOneAndUpdate({
					_id: txn._id
				}, {
					$set: {
						status: "L",
						gas: receipt.gasUsed,
						timeStamp: txn.timeStamp,
						blockNumber: receipt.blockNumber,
					}
				});
				if (txn.txnType === "D" || txn.txnType === "W")
					// then we notify the client of the successful transaction (only withdraw or deposit; no transfers)
					httpUtil.sendTransaction(txn, db);
			} else {
				// if the transaction failed, we resend it (receipt status is not 1)
				logger.error('transaction_checker_job - transaction ' + txn.txnHash + " failed");
				if (process.env.RESEND_TRANSACTION === "Y") {
					await resend(db, txn);
				} else {
					await db.collection('transaction').findOneAndUpdate({
						_id: txn._id
					}, {
						$set: {
							status: "X",
							timeStamp: 0,
							manualResend: false
						}
					});
				}
			}
		}
	} else {
		let timePassed = (currTime - txn.createTime.getTime()) / 1000;
		logger.debug("transaction_checker_job - Time passed: " + timePassed);

		//if there is nonce but no receipt yet, the transaction may not have been sent properly
		if (timePassed > parseInt(process.env.ETH_PENDING_WAIT)) {
			// if the pending time for the transaction exceeds the expected time, we resend the transaction
			logger.error('transaction_checker_job - transaction did not respond after ' + timepassed);
			if (process.env.RESEND_TRANSACTION === "Y")
				await resend(db, txn);
		}
	}
}

const checkAmtTxn = async (db, txn) => {
	const currTime = new Date().getTime();
	let rawTxn = await amtUtil.getRawTransaction(txn.txnHash);
	if (rawTxn && rawTxn.confirmations >= parseInt(process.env.AMT_CONFIRMATION_COUNT)) {
		logger.info("transaction_checker_job - Found successful transaction: " + txn.txnHash);
		const block = await amtUtil.getBlock(rawTxn.blockhash);
		// include the record in those to be marked as "successful"
		txn.timeStamp = rawTxn.time;
		txn.blockNumber = block.height;
		db.collection('transaction').findOneAndUpdate({
			_id: txn._id
		}, {
			$set: {
				status: "L",
				timeStamp: rawTxn.time,
				blockNumber: block.height
			}
		});
		if (txn.txnType === "D" || txn.txnType === "W" || txn.txnType === "S") 
			// then we notify the client of the successful transaction (only withdraw or deposit or send; no internal transfers)
			httpUtil.sendTransaction(txn, db);
	} else {
		let timePassed = (currTime - txn.createTime.getTime()) / 1000;
		logger.debug("transaction_checker_job - Time passed: " + timePassed);

		//if there is nonce but no receipt yet, the transaction may not have been sent properly
		if (timePassed > parseInt(process.env.AMT_PENDING_WAIT)) {
			// if the pending time for the transaction exceeds the expected time, we resend the transaction
			logger.error('transaction_checker_job - transaction did not respond after ' + timePassed);
			if (process.env.RESEND_TRANSACTION === "Y")
				await resend(db, txn);
		}
	}
}

const checkBtcTxn = async (db, txn) => {
	const currTime = new Date().getTime();
	let rawTxn = await btcUtil.getTxn(txn.txnHash);
	if (rawTxn && rawTxn.confirmations >= parseInt(process.env.BTC_CONFIRMATION_COUNT)) {
		logger.info("transaction_checker_job - Found successful transaction: " + txn.txnHash);
		txn.fees = btcUtil.getFees(rawTxn);
		if (!txn.sender) {
			txn.sender = await btcUtil.getTxnSender(rawTxn);
		}
		// include the record in those to be marked as "successful"
		db.collection('transaction').findOneAndUpdate({
			_id: txn._id
		}, {
			$set: {
				status: "L",
				timeStamp: rawTxn.time,
				sender: txn.sender,
				fees: txn.fees
			}
		});
		if (txn.txnType === "D" || txn.txnType === "W")
			// then we notify the client of the successful transaction (only withdraw or deposit; no transfers)
			httpUtil.sendTransaction(txn, db);
		if (txn.txnType === "D") {
			db.collection("address").findOneAndUpdate({
				address: txn.recepient
			}, {
				$set: {
					unsent: txn.amount
				}
			});
		}
	} else {
		let timePassed = (currTime - txn.createTime.getTime()) / 1000;
		logger.debug("transaction_checker_job - Time passed: " + timePassed);
	}
}

const checkEosTxn = async (db, txn) => {
	const txnRes = await eosUtil.getTransaction(txn.txnHash, txn.blockNumber);
	logger.debug(`Transaction ${txn.txnHash} => blocknum: ${txnRes.block_num} , irreversible block: ${txnRes.last_irreversible_block}`)
	if(txnRes && txnRes.trx.receipt.status === "executed" && txnRes.block_num < txnRes.last_irreversible_block) {
		// include the record in those to be marked as "successful"
		db.collection('transaction').findOneAndUpdate({
			_id: txn._id
		}, {
			$set: {
				status: "L",
				timeStamp: moment(txnRes.block_time).toDate().getTime() / 1000,
			}
		});
		if (txn.txnType === "D" || txn.txnType === "W")
			// then we notify the client of the successful transaction (only withdraw or deposit; no transfers)
			httpUtil.sendTransaction(txn, db);
	}
}

/**
 * Resends the transaction. Returns true if the resending was successful and returns false if not.
 */
const resend = async (db, txn) => {
	if (txn.txnType === "D") return; // don't resend deposit
	let resendLimit = parseInt(process.env.RESEND_LIMIT);
	let resendThreshold, txnAmt;
	if (txn.coinType === "ETH") {
		resendThreshold = BigNumber(process.env.RESEND_THRESHOLD_ETH);
		txnAmt = BigNumber(txn.amount);
	} else if (txn.coinType === "AMTC") {
		resendThreshold = BigNumber(process.env.RESEND_THRESHOLD_AMTC);
		txnAmt = etherUtil.getAMTCAmount(txn.amount);
	} else if (txn.coinType === "AMT") {
		resendThreshold = BigNumber(process.env.RESEND_THRESHOLD_AMT);
		txnAmt = BigNumber(txn.amount);
	}
	try {
		// check if the number of attempts has reached the limit and that the amount is less than the threshold
		if (resendLimit === 0 || (txn.pastFailed && txn.pastFailed.length === resendLimit) || txnAmt.gte(resendThreshold)) {
			if (txnAmt.gte(resendThreshold))
				logger.info("transaction_checker_job - Transaction amount exceeds resend threshold. Transaction is cancelled");
			else
				logger.info("transaction_checker_job - Transaction has had " + resendLimit + " previous failed attempts. Transaction is now cancelled. ");
			// if the number of previous failed attempts has been reached, 
			// we mark it as cancelled
			txn.status = "X";
			txn.timeStamp = 0;
			txn.manualResend = false;
		} else {
			logger.info("transaction_checker_job - Resending transaction with ID " + txn._id);
			const addrRecord = await dbUtil.retrieveAddress(db, txn.sender, txn.coinType, txn.txnType);
			let wallet = {
				fromAddress: txn.sender,
				toAddress: txn.recepient,
				key: addrRecord.private,
				amount: txn.amount,
				type: addrRecord.type,
				trace: txn.trace
			};
			var resend;
			// set the transaction hash to blank just to make sure that the failed transaction hash
			// won't be read again 
			await db.collection("transaction").update({
				_id: txn._id
			}, {
				$set: {
					txnHash: ""
				},
				$push: {
					pastFailed: txn.txnHash
				}
			});
			try {
				// resend the transaction but don't add it into the database
				if (txn.coinType === "AMTC" || txn.coinType === "ETH")
					resend = await etherUtil.sendEther(db, wallet, null, false);
				else if (txn.coinType === "AMT")
					resend = await amtUtil.sendAmt(db, wallet, false);
			} catch (err) {
				logger.error("transaction_checker_job - sending job error: " + err.stack);
				return false;
			}
			// the failed transaction is now added to the list of failed transactions
			if (txn.pastFailed) {
				txn.pastFailed.push(txn.txnHash);
			} else {
				txn.pastFailed = [txn.txnHash];
			}
			// the new transaction is the one we watch for
			txn.txnHash = resend.txnHash;
			txn.status = "P";
			txn.nonce = resend.nonce;
			// we reset the create time to the time the resend was made
			txn.createTime = new Date();
		}
		// update the db
		await db.collection("transaction").update({
			_id: txn._id
		}, txn);
	} catch (err) {
		logger.error("transaction_checker_job - transaction_checker_job resend error: " + err.stack);
	}
	// We return true since the transaction was sent successfully
	return true;
}

module.exports = {
	start: (db) => {
		let millisInterval = parseInt(process.env.TRANSACTION_INTERVAL) * 1000;
		logger.debug("Starting up transaction_checker_job. Interval: " + millisInterval);
		setInterval(transactionChecker, millisInterval, db);
	},
	test: (db) => {
		return transactionChecker(db);
	}
};