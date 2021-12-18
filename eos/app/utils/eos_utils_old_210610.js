const BigNumber = require("bignumber.js");
const crypto = require("crypto");
const fetch = require("node-fetch");
const logger = require("../../config/winston");
const axios = require("axios");
const _ = require("lodash");
const moment = require("moment");
const { Api, JsonRpc } = require("eosjs");
const { JsSignatureProvider } = require("eosjs/dist/eosjs-jssig");
const { TextDecoder, TextEncoder } = require("util");

const dbUtil = require("./db_utils");

// load the private key from the hot wallet secret (this will be the only account)
const privateKey = [process.env.EOS_HOT_WALLET_SECRET];
// create the api for transaction sending
const signatureProvider = new JsSignatureProvider(privateKey);
const rpc = new JsonRpc(process.env.EOS_API_URL, { fetch });
const api = new Api({ rpc, signatureProvider, textDecoder: new TextDecoder(), textEncoder: new TextEncoder() });

module.exports = {
	getCoinName: async(db) => {
		const eosSettings = await db.collection("base").findOne({name:"eosSettings"});
		return eosSettings.coinName;
	},
	isCoinName: async(db, name) => {
		const eosSettings = await db.collection("base").findOne({name:"eosSettings"});
		return name === eosSettings.coinName;
	},
	getBalance: async(db, address) => {
		const eosSettings = await db.collection("base").findOne({name:"eosSettings"});
		const bal = await rpc.get_currency_balance(eosSettings.contract, address, eosSettings.coinName);
		const res =  bal.length > 0 ? bal[0] : `0 ${eosSettings.coinName}`;
		const splitRes = res.split(" ");
		return splitRes[0];
	},
	getTransactions: async (account, position, offset, eosSettings) => {
		const response = await axios.post(process.env.EOS_EXPLORER_API_URL, {
			'account_name': account,
			'pos': position,
			'offset': offset
		});
		if (response.status == 200) {
			if (response.data.actions.length > 0) {
				let txns = _.filter(response.data.actions, o => {
					return o.action_trace.act.name == "transfer" &&
						o.action_trace.act.account == eosSettings.contract &&
						o.action_trace.receiver == account;
				}).map(cur => {
					return _.merge(cur.action_trace.act.data, {
						blockNumber: cur.block_num,
						accountSeq: cur.account_action_seq,
						hash: cur.action_trace.trx_id,
						timeStamp: moment(cur.action_trace.block_time).toDate().getTime() / 1000,
					});

				});
				let minSeq = response.data.actions[0].account_action_seq;
				let maxSeq = response.data.actions[response.data.actions.length - 1].account_action_seq;
				let delta = maxSeq - minSeq;
				let lastBlk = response.data.last_irreversible_block;
				return {
					minSeq: minSeq,
					maxSeq: maxSeq,
					delta: delta,
					txns: txns,
					lastBlock: lastBlk
				};
			}        
			return {
				minSeq: 0,
				maxSeq: 0,
				delta: 0,
				txns: [],
				lastBlock: 0
			};
		} else {
			logger.error("error response from server", response.statusText);      
		}    
	},
	getTransaction: async (txnId, blockNum) => {
		const res =	await rpc.history_get_transaction(txnId, blockNum);
		return res;
	},
	createEosWallet: async (res, db) => {
		var id = crypto.randomBytes(20).toString('hex').substr(0, 10);
		const eosSettings = await db.collection("base").findOne({name:"eosSettings"});
		const address = eosSettings.prefix + "-" + id;
		const record = { address, type: eosSettings.coinName, use: "D" };
		await db.collection("address").insert(record);
		res.send(record);
	},
	createEosWithdraw: async (withdrawals, db, after) => {
		try {
			// connect to the contract
			var coinType = withdrawals.type.toUpperCase();
			logger.info("eos_utils.createEosWallet - Creating a EOS withdraw request");
			var hotAddress = process.env.EOS_HOT_WALLET;

			let withdrawRequest = { hotAddress, transactions: [] };

			var totalAmount = new BigNumber(0), totalGas = 0;

			for (let i = 0; i < withdrawals.request.length; i++) {
				let request = withdrawals.request[i];
				let amt = BigNumber(request.amount);
				let trace = request.trace || '';
				request.address = request.address.trim();
				let addr = request.address;

				// check if the amount being sent is equal to zero or negative
				if (amt.lte(BigNumber(0))) {
					logger.warn("eos_utils.createEosWallet - Negative or zero amounts are not allowed");
					after({
						error: "Negative or zero amounts are not allowed"
					});
					return;
				}

				let hasTrace = await dbUtil.hasSameTrace(db, trace);
				if (hasTrace) {
					logger.warn("eos_utils.createEosWallet - Trace already exists in the database: " + trace);
					after({
						error: "Trace exists in database: " + trace
					});
					return;
				}

				let details = {
					id: crypto.randomBytes(16).toString('hex'),
					// gas: web3.toHex(gas),
					amount: amt.toString(),
					requestAddr: request.address,
					sent: false,
					trace
				};
				logger.debug(`eos_utils.createEosWallet - ${JSON.stringify(details)}`);

				withdrawRequest.transactions.push(details);
				totalAmount = totalAmount.plus(amt);
			}

			withdrawRequest.totalAmount = totalAmount.toString();
			withdrawRequest.coinType = coinType;
			withdrawRequest.estimateGas = totalGas;
			withdrawRequest.sentAmount = false;
			withdrawRequest.createDt = new Date();
			// check if the request requires approval first
			if (withdrawals.approved) {
				logger.debug(`eos_utils.createEosWallet - approved withdrawal request with amount ${totalAmount}`);
				withdrawRequest.approvedStatus = "A";
			} else {
				let wdApproval = process.env.WITHDRAW_EOS_APPROVAL;
				logger.debug(`eos_utils.createEosWallet - withdraw approval amount: ${wdApproval}`);
				if (wdApproval) {
					let withdrawAmt = BigNumber(totalAmount);
					let isApproved = withdrawAmt.lte(BigNumber(wdApproval));
					withdrawRequest.approvedStatus = isApproved ? "A" : "P";
				} else {
					logger.debug(`eos_utils.createEosWallet - no withdraw approval amount. Automatically approving`);
					withdrawRequest.approvedStatus = "A";
				}
			}
			logger.debug(`eos_utils.createEosWallet - ${JSON.stringify(withdrawRequest)}`);
			db.collection("withdraw_request").insert(withdrawRequest, (err, item) => {
				if (err) {
					after({
						error: "An error has occurred"
					});
					logger.error('eos_utils.createEosWallet - error: ' + err.stack);
				} else {
					let requestDetails = {
						requestId: item.ops[0]._id,
						address: hotAddress,
						totalAmount,
					};
					after(requestDetails);
					logger.info("eos_utils.createEosWallet - Inserted withdraw request with ID " + requestDetails.requestId);
				}
			});
		} catch (err) {
			logger.error('eos_utils.createEosWallet - ' + err.stack);
			after({
				error: "An error occurred while processing the request"
			});
		}
	},
	send: async (db, wallet, callback, willAdd = true) => {
		const eosSettings = await db.collection("base").findOne({name:"eosSettings"});
		const quantity = `${new BigNumber(wallet.amount).toFixed(eosSettings.precision).toString()} ${eosSettings.coinName}`;
		logger.info(`Sending ${quantity} from ${process.env.EOS_HOT_WALLET} to ${process.env.EOS_COLD_WALLET}`);
		const receiverLs = wallet.toAddress.split("|");
		logger.debug(`Withdraw receivers: ${receiverLs}`);
		const res = await api.transact({
			actions: [{
				account: eosSettings.contract,
				name: "transfer",
				authorization: [{ actor: wallet.fromAddress, permission: "active"}],
				data: { quantity, from: wallet.fromAddress, to: receiverLs[0], memo: receiverLs[1]}
			}]
		}, {	blocksBehind: 3, expireSeconds: 30 });
		const txnId = res.transaction_id;
		logger.info("eos_utils.send - Transaction sent: " + txnId);
		// we build the transaction details to be stored in the database
		let txnDetails = {
			status: "P",
			coinType: eosSettings.coinName,
			txnType: wallet.use,
			sender: wallet.fromAddress,
			recepient: receiverLs[0],
			memo: receiverLs[1],
			amount: wallet.amount,
			txnHash: txnId,
			createTime: new Date(),
			timeStamp: 0,
			trace: wallet.trace,
			blockNumber: res.processed.block_num
		};

		if (willAdd) {
			try {
				await db.collection("transaction").insert(txnDetails);
				logger.info("eos_utils.send - Inserted transaction: " + txnId);
			} catch (err) {
				logger.error("eos_utils.send - error occurred inserting transaction into database " + err.stack);
			}
		}

		if (callback) {
			try {
				callback(txnDetails);
			} catch (err) {
				logger.error("eos_utils.send - error occurred during callback");
			}
		}

		return txnDetails;
	}
}