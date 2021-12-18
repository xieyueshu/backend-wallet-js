const fs = require("fs");
const Web3 = require("web3");
const axios = require("axios");
const BigNumber = require("bignumber.js");
const _ = require("lodash");
const InputDataDecoder = require('ethereum-input-data-decoder');

const base = require("../utils/base_utils");
const amtUtil = require("../utils/amt_utils");
const btcUtil = require("../utils/btc_utils");
const dbUtil = require("../utils/db_utils");
const ethUtil = require("../utils/eth_utils");
const eosUtils = require("../utils/eos_utils");
const httpUtil = require("../utils/http_utils");
const secUtil = require("../utils/security_utils");
const cp = require("child_process");

const logger = require("../../config/winston-job");

var child = null;
var isRunning = false;
var abiArray = JSON.parse(fs.readFileSync('resources/contract.json', 'utf-8'));
const decoder = new InputDataDecoder(abiArray);
let amtAsset = null;

async function depositChecker(db) {
	if (!isRunning) {
		isRunning = true;
		logger.debug("deposit_checker_job- running");
		try {
			let isBind = process.env.USES_BIND_WALLET_D === 'Y';
			let chainList = process.env.CHAIN_SUPPORT;
			if (chainList.includes("ETH"))
				await retrieveEthTxns(db, isBind);
			if (chainList.includes("AMT"))
				await retrieveAmtTxns(db, isBind);
			if (chainList.includes("BTC"))
				await retrieveBtcTxns(db, isBind);
			if (chainList.includes("EOS"))
				await retrieveEosTxns(db, isBind);
		} catch (err) {
			logger.error("deposit_checker_job - error: " + err.stack);
		}
		isRunning = false;
	} else {
		logger.debug("Skipped transaction_checker_job run due to ongoing operation");
	}

}

const getAmtSender = async function (txn) {
	let senders = [];
	for (let cnt = 0; cnt < txn.vin.length; cnt++) {
		let vin = txn.vin[cnt];
		try {
			if (vin.txid) {
				let inTxn = await amtUtil.getRawTransaction(vin.txid);
				let out = inTxn.vout[vin.vout].scriptPubKey.addresses;
				senders = senders.concat(out);
			}
		} catch (err) {
			logger.warn("deposit_checker_job - error while getting sender" + err.message);
		}
	};
	// filter out any undefined elements (from repeated vouts)
	senders = senders.filter(sender => sender !== undefined);
	// convert to set to remove repeated values and back to an array 
	senders = Array.from(new Set(senders));
	if (senders.length === 1) return senders[0];
	else return senders.toString();
};

const retrieveAmtTxns = async (db, bind) => {
	var txnHashList = [];
	let fromBlk = await dbUtil.getBaseItemValue(db, "lastBlkNumAtm");
	let lastBlkNum = await amtUtil.getLastBlock();
	let toBlk = lastBlkNum - parseInt(process.env.AMT_CONFIRMATION_COUNT);
	logger.debug("deposit_checker_job - From AMT blk num: " + fromBlk + "; To AMT blk num: " + toBlk);

	let rates = await db.collection("base").findOne({
		name: "exchangeRates"
	});
	rates = rates[process.env.DEFAULT_CURRENCY];

	// get the list of transaction hashes in the blocks
	for (var i = fromBlk; i < toBlk; i++) {
		logger.debug("deposit_checker_job - retrieving AMT block " + i);
		// 4 - verbose block information: include transaction data
		let block = await amtUtil.getBlock(i, 4);
		let txns = block.tx.map((tx) => {
			tx.time = block.time;
			tx.blockNumber = block.height;
			return tx;
		})
		txnHashList = txnHashList.concat(txns);
	}
	logger.debug("deposit_checker_job - Found " + txnHashList.length + "AMT transactions");

	amtAsset = base.getValueMem("asset");
	let walletList = [], walletRec = {};
	let txnDbList = await db.collection('transaction').find({
		txnType: "D",
		coinType: {$in: ["AMT", "AMT_A"]},
		status: "L"
	}).toArray();
	txnDbList = txnDbList.map(t => t.txnHash);
	if (bind) {
		walletList = [{
			address: process.env.AMT_COLD_WALLET,
			type: "AMT"
		},
		{
			address: process.env.AMT_COLD_ASSET_WALLET,
			type: "AMT_A"
		}];
	} else {
		// retrieve the addresses from the database
		walletList = await db.collection('address').find({
			use: 'D', type: {$in: ["AMT", "AMT_A"]}
		}).toArray();
		walletList.map((w) => {
			walletRec[w.address] = {
				type: w.type,
				address: w.address,
				private: w.private,
				amount: w.unsent || 0
			};
			return w.address;
		});
	}
	// filter out the AMT addresses only
	const amtAddr = walletList.filter(a => a.type === 'AMT').map(a => a.address);
	// filter out the AMT_A addresses only
	const assetAddr = walletList.filter(a => a.type === 'AMT_A').map(a => a.address);
	logger.debug("deposit_checker_job - Number of amt addresses: " + amtAddr.length + "; AMT_A addresses: " + assetAddr.length);

	// go through all transactions retrieved
	for (let i = 0; i < txnHashList.length; i++) {
		let txn = txnHashList[i];
		// hash found in database; skip
		if (txnDbList.indexOf(txn.txid) !== -1) {
			logger.debug("deposit_checker_job - transaction " + txn.txid + " found in the database. Skipped.");
			continue;
		}
		let txid = txn.txid,
			timeStamp = txn.time,
			vout = txn.vout,
			blockNumber = txn.blockNumber;
		let txDeposit = {};
		let sender = await getAmtSender(txn);
		if (!sender) continue; // no sender so continue to next transaction
		logger.debug(`deposit_checker_job - senders of transaction: ${sender}`);
		// skip the last one since this is the sender's new balance
		for (let v = 0; v < vout.length; v++) {
			let out = vout[v];
			if (out.scriptPubKey && out.scriptPubKey.addresses) {
				// get addresses that aren't among the input addresses
				// and filter out addresses that aren't on the watch list
				const toAddr = out.scriptPubKey.addresses
					.filter(addr => sender.search(addr) === -1)
				// extract amtc and asset transfers for this vout
				if(toAddr.length > 0){
					const toAmt = toAddr.filter(addr => amtAddr.includes(addr));
					Object.assign(txDeposit, extractAddrAmts(toAmt, out));
					const toAsset = toAddr.filter(addr => assetAddr.includes(addr));
					Object.assign(txDeposit, extractAddrAmts(toAsset, out, true));
				}
			}
		}
		if (Object.keys(txDeposit).length > 0) {
			const txDetails = {bind, sender, txid, timeStamp, rates, blockNumber}
			await processDeposits(db, txDeposit, txDetails, walletRec);
		}

	}
	// send all deposits to the cold wallet automatically
	if (process.env.MANUAL_DEPOSIT === "N") { 
		// retrieve addresses that have deposits
		let depositedWallets = Object.keys(walletRec).filter(wallet => walletRec[wallet].amount > 0);
		for (let i = 0; i < depositedWallets.length; i++) {
			let wallet = depositedWallets[i];
			logger.info("deposit_checker_job - Forwarding " + walletRec[wallet].amount + " from " + walletRec[wallet].address);
			try {
				if(walletRec[wallet].type === "AMT_A") walletRec[wallet].asset = amtAsset.assetref;
				walletRec[wallet].private = secUtil.decryptKey(walletRec[wallet].private);
				await amtUtil.transferToCold(db, walletRec[wallet]);
				await db.collection("address").findOneAndUpdate(
					{address: wallet}, 
					{$set: {unsent: 0}}
					);
			} catch (e) {
				logger.warn("deposit_checker_job - error forwarding deposit: " + e.stack);
			}
		}
	}

	logger.debug("deposit_checker_job - Last processed ATM block: " + toBlk);
	await db.collection('base').updateOne({
		name: "lastBlkNumAtm"
	}, {
		$set: {
			value: toBlk
		}
	});

}

const retrieveEthTxns = async (db, isBind) => {
	// retrieve the starting and ending block
	logger.debug("entering retrieveEthTxns");
	const web3 = new Web3(new Web3.providers.HttpProvider(process.env.NODE_ETH_NETWORK));
	var txnHashList = [];
	let fromBlk = await db.collection('base').findOne({
		name: "lastBlkNum"
	});
	logger.debug("deposit_checker_job - obtained lastBlkNum from db: " + fromBlk.value);
	let lastBlkNum = await ethUtil.getLatestBlock(web3);
	let toBlk = lastBlkNum - parseInt(process.env.ETH_CONFIRMATION_COUNT);
	if (toBlk - fromBlk.value > 60) {
		toBlk = fromBlk.value + 60;
	}
	logger.debug("deposit_checker_job - From blk num: " + fromBlk.value);
	logger.debug("deposit_checker_job - To blk num: " + toBlk);
	// get the list of transaction hashes in the blocks
	for (var i = fromBlk.value; i < toBlk; i++) {
		logger.debug("deposit_checker_job - retrieving block " + i);
		let block = await ethUtil.getBlock(web3, i, true);

		let txns = block.transactions.map((txn) => {
			
			if (txn.type == 'rpctx' && txn.value.txType == 'tx'){
				txn = txn.value.tx.value;
				txn.from = txn.value.from;
				txn = web3._extend.formatters.outputTransactionFormatter(txn);
			}

			txn.timeStamp = block.timestamp; 
			txn.blockNumber = block.number;
			
			return txn;

			// txn.timeStamp = block.timestamp;
			// return txn;
		});

		txnHashList = txnHashList.concat(txns);
	}
	logger.debug("deposit_checker_job - Found " + txnHashList.length + " transactions");

	let rates = await db.collection("base").findOne({
		name: "exchangeRates"
	});
	rates = rates[process.env.DEFAULT_CURRENCY];
	// retrieve the list of addresses from the database
	let addrList = [],
		walletRec = [];
	let txnDbList = await db.collection('transaction').find({
		txnType: "D",
		coinType: {
			$in: ["AMTC", "ETH"]
		},
		status: "L"
	}).toArray();
	txnDbList = txnDbList.map(t => t.txnHash);
	if (isBind) {
		addrList = [{
				address: process.env.ETH_COLD_AMTC_WALLET,
				type: "AMTC"
			},
			{
				address: process.env.ETH_COLD_ETH_WALLET,
				type: "ETH"
			}
		];
	} else {
		addrList = await db.collection('address').find({
			use: 'D',
			type: {
				$in: ["AMTC", "ETH"]
			}
		}).toArray();
	}
	if (addrList.length !== 0) {
		walletRec = addrList.reduce((records, wallet) => {
			if (!wallet.unsent)
				wallet.unsent = BigNumber(0);
			else wallet.unsent = BigNumber(wallet.unsent);
			records[wallet.address] = wallet;
			return records;
		}, {});
		// filter out the ETH addresses only
		let ethAddr = addrList.filter(a => a.type === 'ETH').map(a => a.address.toLowerCase());
		logger.debug("deposit_checker_job - Number of eth addresses: " + ethAddr.length);
		// filter out the AMTC addresses only
		let amtcAddr = addrList.filter(a => a.type === 'AMTC').map(a => a.address.toLowerCase());
		logger.debug("deposit_checker_job - Number of amtc addresses: " + amtcAddr.length);
		let markedAddr = await getMarkedAddresses(db);
		logger.debug("deposit_checker_job - Number of marked addresses: " + markedAddr.length);

		const contractAddr = process.env.ETH_CONTRACT_ADDRESS.toLowerCase();
		const ethDecPlaces = BigNumber(10).pow(BigNumber(18));
		for (let i = 0; i < txnHashList.length; i++) {
			let txn = txnHashList[i];
			if (txnDbList.indexOf(txn.hash) !== -1) {
				logger.debug("deposit_checker_job - transaction found in the database... skipping");
				continue; // move on to the next transaction
			}
			let to = txn.to;
			if (to) {
				to = to.toLowerCase();
				// if successful transaction, we check if the recipient is one of the addresses 
				// or the contract address
				if (contractAddr === to) {
					// the sent amount is in the token registered (AMTC)
					const result = decoder.decodeData(txn.input);
					if (result.inputs[0]) {
						const to = "0x" + result.inputs[0].toLowerCase();
						if (amtcAddr.indexOf(to) !== -1) {
							// the token has been sent to a generated wallet
							logger.info("deposit_checker_job - found AMTC transaction for " + to + ": " + txn.hash);
							let receipt = await ethUtil.getReceipt(web3, txn.hash);
							if (receipt.status === "0x1") {
								logger.debug("deposit_checker_job - Creating and sending AMTC transaction");
								const amt = result.inputs[1].toString();
								const amtcAmt = ethUtil.getAMTCAmount(amt);
								await createAndSendTxn(db, txn, {
									coin: "AMTC",
									amount: amtcAmt.toString(),
									to,
									rate: (rates) ? rates.amtc : 0,
									isMarked: markedAddr.indexOf(to) !== -1
								});
								if (!walletRec[to].unsent)
									walletRec[to].unsent = amtcAmt;
								else
									walletRec[to].unsent = amtcAmt.plus(walletRec[to].unsent);
							}
						}
					}
				} else if (ethAddr.indexOf(to) !== -1) {
					// there has been an eth deposit into the generated wallet
					logger.info("deposit_checker_job - found ETH transaction for " + to + ": " + txn.hash);
					let receipt = await ethUtil.getReceipt(web3, txn.hash);
					// successful transaction so we send it to the client
					if (receipt.status === "0x1") {
						logger.debug("deposit_checker_job - Creating and sending ETH transaction");
						const ethAmt = BigNumber(txn.value).div(ethDecPlaces);
						await createAndSendTxn(db, txn, {
							coin: "ETH",
							amount: ethAmt.toString(),
							rate: (rates) ? rates.eth : 0,
							isMarked: markedAddr.indexOf(to) !== -1
						});
						if (!walletRec[to].unsent)
							walletRec[to].unsent = ethAmt;
						else
							walletRec[to].unsent = ethAmt.plus(walletRec[to].unsent);
					}
				}
			}
		}
	}
	// send all deposits to the cold wallet automatically
	if (process.env.MANUAL_DEPOSIT === "N" && !isBind) {
		await forwardAllDeposit(db, walletRec, web3);
	} else {
		let depositedWallets = Object.keys(walletRec).filter(wallet => walletRec[wallet].unsent.gt(0));
		for(const addr in walletRec) {
			if(walletRec.hasOwnProperty(addr)) {
				await db.collection("address").findOneAndUpdate({ address: addr }, 
					{ $set: { unsent: walletRec[addr].unsent.toNumber() } }
				);
			}
		}
	}
	logger.debug("deposit_checker_job - Last processed block: " + toBlk);
	// logger.debug(JSON.stringify(txnList));
	await db.collection('base').updateOne({
		name: "lastBlkNum"
	}, {
		$set: {
			value: toBlk
		}
	});
}

const forwardAllDeposit = async (db, walletRec, web3) => {
	// retrieve addresses that have deposits
	let depositedWallets = Object.keys(walletRec).filter(wallet => walletRec[wallet].unsent.gt(BigNumber(0)));
	for (let i = 0; i < depositedWallets.length; i++) {
		let wallet = depositedWallets[i];
		let transferSuccess = false;
		try {
			walletRec[wallet].private = secUtil.decryptKey(walletRec[wallet].private);
			walletRec[wallet].amount = walletRec[wallet].unsent.toNumber();
			await db.collection("address").findOneAndUpdate({
				address: wallet
			}, {
				$set: {
					unsent: walletRec[wallet].amount
				}
			});
			if (walletRec[wallet].type === "ETH") {
				transferSuccess = await ethUtil.transferToColdEth(db, walletRec[wallet]);
			} else if (walletRec[wallet].type === "AMTC") {
				if(new BigNumber(walletRec[wallet].amount).lt(process.env.ETH_GAS_AMTC_MIN || 0)){ 
					logger.debug(`deposit_checker_job - ${walletRec[wallet].address} doesn't have enough tokens`)
					continue;
				}
				transferSuccess = await ethUtil.transferToColdAmtc(walletRec[wallet], db, web3, walletRec[wallet].amount);	
			}
			if(transferSuccess) {
				await db.collection("address").findOneAndUpdate({
					address: wallet
				}, {
					$set: {
						unsent: 0
					}
				});
			}
		} catch (e) {
			logger.warn("deposit_checker_job - error forwarding deposit: " + e.stack);
		}
	}
}

const createAndSendTxn = async (db, txn, det) => {
	let txnDetails = {
		txnType: "D",
		coinType: det.coin,
		sender: txn.from,
		recepient: det.to || txn.to,
		amount: det.amount,
		createTime: new Date(),
		gas: txn.gas || 0,
		nonce: txn.nonce || 0,
		txnHash: txn.hash,
		status: "L",
		timeStamp: txn.timeStamp,
		blockNumber: txn.blockNumber || 0,
		memo: det.memo || "",
	};
	if (det.rate) {
		txnDetails["RP"] = BigNumber(det.amount).times(BigNumber(det.rate)).toString();
		if (det.isMarked) {
			logger.debug("deposit_checker_job - found marked address. Sending extra IP");
			txnDetails["FP"] = BigNumber(txnDetails["RP"]).times(BigNumber("0.1")).toString();
		}
	}
	logger.debug("deposit_checker_job - " + JSON.stringify(txnDetails));

	await db.collection('transaction').insert(txnDetails);
	// send the transaction to the client
	httpUtil.sendTransaction(txnDetails, db);
}


const getMarkedAddresses = async (db) => {
	logger.debug("deposit_checker_job - Getting marked addresses from the database");
	let markedAddrDb = await db.collection("marked_address").find({}).toArray();
	if (markedAddrDb && markedAddrDb.length > 0) {
		return markedAddrDb.map(a => a.address.toLowerCase());
	} else {
		return [];
	}
}

const retrieveBtcTxns = async (db) => {
	if (process.env.BTC_INSIGHT_SUPPORT === "N") {
		if(child){
			logger.warn("deposit_checker_job - unable to run btc deposit due to ongoing process");
		} else {
			child = cp.fork('app/processes/btc_deposit_process.js', [global.APP_HASH, global.SHARED_KEY]);
			child.on('message', function(data) {
				logger.debug("deposit_checker_job - Received data from btc_deposit_process: " + data);
				if(data === "DONE"){
					logger.info("deposit_checker_job - Killing child btc_deposit_process");
					child.kill();
					child = null;
				}
			});
		}
	} else {
		if (process.env.MANUAL_DEPOSIT === "Y") return;
		let walletList = await db.collection('address').find({
			use: 'D',
			type: {
				$in: ["BTC"]
			},
			unsent: {
				$gt: 0
			}
		}).toArray();
		for (let i = 0; i < walletList.length; i++) {
			let addr = walletList[i];
			addr.private = secUtil.decryptKey(addr.private);
			await btcUtil.forwardDeposit(db, addr);
			await db.collection("address").findOneAndUpdate({
				address: addr.address
			}, {
				$set: {
					unsent: 0
				}
			});
		}
	}
}

const extractAddrAmts = (toAddr, out, isAsset = false) => {
	if(toAddr.length === 0) return {};
	let deposits = {}
	let txnAmt = 0;
	if(isAsset && amtAsset && out.assets){
		txnAmt = out.assets
		.filter(a=>a.assetref === amtAsset.assetref)
		.map(a => a.qty)
		.reduce((total, qty) => total + qty, 0);
	}
	if(!isAsset && out.value > 0){
		txnAmt = out.value;
	} 
	toAddr.forEach((addr) => {
		if(txnAmt > 0) deposits[addr] = txnAmt;
	});
	return deposits
}

const processDeposits = async (db, txDeposit, details, walletRec) => {
	const rates = details.rates;
	for (addr in txDeposit) {
		const type = walletRec[addr].type;
		const amount = txDeposit[addr];
		// update in-memory list of unsent for auto-sending
		walletRec[addr].amount += amount;
		// create a deposit for all assets and AMTC received
		await createAndSendTxn(db, {
			from: details.sender, to: addr, 
			hash: details.txid, timeStamp: details.timeStamp,
			blockNumber: details.blockNumber
		}, {
			coin: type, amount: amount, 
			rate: (rates && type === "AMT") ? rates.amtc : 0
		});
		if (!details.bind) {
			await db.collection("address").findOneAndUpdate({
				address: addr
			}, {
				$set: {
					unsent: walletRec[addr].amount
				}
			});
		}
	}
}

const retrieveEosTxns = async (db, pos = -1) => {
	const eosSettings = await db.collection("base").findOne({name: "eosSettings"});
	const PAGE_SIZE = parseInt(process.env.EOS_PAGE_SIZE || "100");
	let lastEndSeq = lastStartSeq = eosSettings.lastStartSeq;
	logger.debug(`Retrieving transaction starting with: ${lastStartSeq}`);
	const checkDeposit = async (account, pos) => {  
		const data = await eosUtils.getTransactions(account, pos, PAGE_SIZE, eosSettings);
		eosSettings.lastBlk = data.lastBlock;
		await processEosTransactions(db, eosSettings, data.txns);
		// last entry is > previously processed last entry (new entries to process)
		// first entry is > previous processed first entry
		if ((data.delta>0) && ((data.maxSeq > lastEndSeq || lastEndSeq==-1) || (data.minSeq > lastStartSeq))){  
			lastEndSeq = lastStartSeq = data.maxSeq;
			logger.debug(`calling check deposit with minSeq: ${data.maxSeq}`);
			await checkDeposit(account, data.maxSeq);
		} else {
			await db.collection("base").findOneAndUpdate({name:"eosSettings"}, {$set:{ lastStartSeq: lastEndSeq }});
			logger.info(`Updated lastStartSeq to ${lastStartSeq}`);
		}
	}
	await checkDeposit(process.env.EOS_COLD_WALLET, eosSettings.lastStartSeq);
}

const processEosTransactions = async (db, eosSettings, txnList) => {
	const addrDb = await db.collection("address").find({ use: "D", type: eosSettings.coinName }).toArray();
	const addrList = addrDb.map(a => a.address);
	const txnDb = await db.collection("transaction").find({txnType: "D", coinType: eosSettings.coinName}).toArray();
	const depositList = txnDb.map(t => t.txnHash);
	for (const txn of txnList) {
		if (eosSettings.lastBlk < txn.blockNumber || depositList.includes(txn.hash)) continue;
		if (addrList.includes(txn.memo)) {
			const amount = txn.quantity.split(" ")[0];
			const det = {
				amount,
				coin: eosSettings.coinName,
				to: process.env.EOS_COLD_WALLET,
				memo: txn.memo
			}
			await createAndSendTxn(db, txn, det);
		}
	} 
}

module.exports = {
	start: (db) => {
		let millisInterval = parseInt(process.env.DEPOSIT_INTERVAL) * 1000;
		logger.debug("Starting up deposit_checker_job. Interval: " + millisInterval);
		setInterval(depositChecker, millisInterval, db);
	},
	test: (db) => {
		return depositChecker(db);
	}
};
