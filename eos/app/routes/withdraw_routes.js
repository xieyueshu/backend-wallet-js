const Web3 = require("web3");
const ObjectID = require("mongodb").ObjectID;

const ltkUtil = require("../utils/ltk_utils");
const ethUtil = require("../utils/eth_utils");
const btcUtil = require("../utils/btc_utils");
const omniUtil = require("../utils/omni_utils");
const amtUtil = require("../utils/amt_utils");
const secUtil = require("../utils/security_utils");
const routeUtil = require("../utils/route_utils");
const eosUtil = require("../utils/eos_utils");
const logger = require("../../config/winston");
const {isLoggedIn, hasPermissionAction} = require("../utils/route_utils");

const returnWithdrawRequest = (res, details)  => {
	if(details.hasOwnProperty("requestId")) {
		details.requestId = details.requestId.toString();
		details.totalAmount = details.totalAmount.toString();
		const sign = secUtil.signData(details);
		details.sign = sign;
	}
	res.send(details);
};

module.exports = function(app, db) {
	/*
	 * Gets withdraw transactions based on parameters given
	 */
	app.get('/getWithdrawTransaction', async (req, res) => {
		try{
			let coinType = req.query.coinType ? req.query.coinType.toUpperCase() : "AMTC";
			if(amtUtil.isAmtAsset(coinType)){
				coinType = "AMT_A";
			}

			let after = parseInt(req.query.after) || 0;

			let txns = await getWithdrawTxns(db,coinType,after);
			let failed = txns.filter(txn => txn.status === "X" && !txn.manualResend);
			logger.debug("/withdrawAdmin - failed: " + failed.length);
			let completed = txns.filter(txn => txn.status === "L");
			logger.debug("/withdrawAdmin - completed: " + completed.length);
			let pending = txns.filter(txn => txn.status === "P");
			logger.debug("/withdrawAdmin - pending: " + pending.length);
	
			let query = req.query;
			logger.debug("/withdrawAdmin - queries: " + JSON.stringify(query));
			let data = {failed, completed, pending};
			if(query.data){
				if(query.data === "all")
					res.send(data);
				else
					res.send(data[query.data]);
			} else {
				res.send({error: "data field required"});
			} 
		} catch(err){
			logger.error("/withdrawAdmin - " + err.stack);
			res.status(500).send({error:"Unable to retrieve data"});
		}
	});

	/*
	 * Gets withdraw requests based on parameters given
	 */
	app.get('/getWithdrawRequest', async (req, res) => {
		try{
			let coinType = req.query.coinType ? req.query.coinType.toUpperCase() : "AMTC";
			if(amtUtil.isAmtAsset(coinType)){
				coinType = "AMT_A";
			}

			let query = req.query;
			let count = parseInt(query.count || 0);
			let page = parseInt(query.page || 1);
			let skip = (page - 1) * count;
			let sortField = query.sort;
			let sortDir = (query.sortDir === "asc") ? 1 : -1;
			const dbquery = { data: query.data, count, page, skip, sortField, sortDir };
			let requests = await getWithdrawRequests(db, coinType, dbquery);
			
			logger.debug("/withdrawAdmin - queries: " + JSON.stringify(query));
			if(query.data){
					res.send(requests);
			} else {
				res.send({error: "data field required"});
			} 
		} catch(err){
			logger.error("/withdrawAdmin - " + err.stack);
			res.status(500).send({error:"Unable to retrieve data"});
		}
	});

	/*
	 * Gets withdraw stats 
	 */
	app.get('/getWithdrawStats', async (req, res) => {
		try{
			let coinType = req.query.coinType ? req.query.coinType.toUpperCase() : "AMTC";
			if(amtUtil.isAmtAsset(coinType)){
				coinType = "AMT_A";
			}

			const count = {};
			const txnStats = await db.collection("transaction").mapReduce(function() {
				if(this.status === "X" && this.manualResend) return;
				emit(this.status, { amount: parseFloat(this.amount), count: 1});
			}, function(key, objVals) {
				reducedVal = { count: 0, amount: 0 };
				for (let val of objVals) {
					reducedVal.count += val.count;
					reducedVal.amount += val.amount;
				}
				return reducedVal;
			}, { query: { txnType:"W", coinType }, out: {inline:1} });
			
			const requestStats = await db.collection("withdraw_request").mapReduce(function() {
				const amount = parseFloat(this.totalAmount);
				emit(this.approvedStatus, { amount, count: 1});
			}, function(key, objVals) {
				reducedVal = { count: 0, amount: 0 };
				for (let val of objVals) {
					reducedVal.count += val.count;
					reducedVal.amount += val.amount;
				}
				return reducedVal;
			}, { query: { coinType, sentAmount: false }, out: {inline:1} });
			res.send({ request: requestStats, transaction: txnStats });
		} catch(err){
			logger.error("/withdrawAdmin - " + err.stack);
			res.status(500).send({error:"Unable to retrieve data"});
		}
	});

	/**
	 * Creates a withdraw request (a record that contains the addresses and amounts passed)
	 */
	app.post('/withdraw', async (req, res)=>{
		logger.info("/withdraw - called");
		if(req.body.type){
			if(req.body.request.length === 0) {
				return res.send({ error: "No request included" });
			}
			if(process.env.SIGNATURE_CHECK === "Y" && !secUtil.validateSignature(req.body)) {
				logger.warn("/withdraw - invalid signature received");
				return res.send({error: "Invalid signature", code: "INVALID_SIGNATURE"});
			} 
			let type = req.body.type.toUpperCase();
			let chainList = process.env.CHAIN_SUPPORT;
			if((ethUtil.isEthToken(type) || type === "ETH") && chainList.includes("ETH"))
				ethUtil.createEthWithdrawRequest(req.body, db, function(details){
					returnWithdrawRequest(res, details);				
				});			
			else if(type === "BTC" && chainList.includes("BTC"))
				btcUtil.createBtcWithdrawRequest(req.body, db, function(details){
					returnWithdrawRequest(res, details);
				});			
			else if(type === "OMNI" && chainList.includes("BTC"))
				returnWithdrawRequest(res, await omniUtil.saveWithdrawRequest(db, req.body));			
			else if(type === "AMT" && chainList.includes("AMT"))
				amtUtil.createAmtWithdrawRequest(req.body, db, function(details){
					returnWithdrawRequest(res, details);
				});			
			else if(chainList.includes("AMT") && amtUtil.isAmtAsset(type)){
				req.body.type = "AMT_A";
				amtUtil.createAmtWithdrawRequest(req.body, db, function(details){
					returnWithdrawRequest(res, details);
				});			
			} else if (await eosUtil.isCoinName(db, type) && chainList.includes("EOS")){
					eosUtil.createEosWithdraw(req.body, db, function(details){
						returnWithdrawRequest(res, details);
					});			
			} else {
				logger.warn("/withdraw - type not recognized " + req.body.type);
				res.send({error: "Type not recognized"});
			}
		} else {
			logger.warn("/withdraw - type cannot be blank");
			res.send({error: "Type cannot be blank"});
		}
	});

	/**
	 * Marks the withdraw requests as approved
	 */
	app.post("/approveWithdrawal",[isLoggedIn, hasPermissionAction], async (req, res) => {
		try{
			let requestIds = req.body.data.map(x => ObjectID(x));
			logger.debug("/approveWithdrawal - approving withdrawals with ID " + JSON.stringify(requestIds));

			let dbReq = await db.collection("withdraw_request").find({_id:{$in:requestIds}, approvedStatus: "P", sentAmount:false}).toArray();
			logger.debug(`/approveWithdrawal - request ids: ${requestIds.length} && db ids: ${dbReq.length}`);
			if(dbReq.length !== requestIds.length){
				routeUtil.after(req,res,{
					res: {error: "Passed Request ID not valid for approval"},
					redirectQuery: "/?request=requests&status=fail"
				});
				return;
			}
			
			await db.collection("withdraw_request").update(
				{_id:{$in:requestIds}},
				{$set:{approvedStatus: "A"}},
				{multi: true}
			);
			
			if(dbReq.length > 0 && ["AMT", "AMT_A"].includes(dbReq[0].coinType)  && process.env.WITHDRAW_BALANCE_NOTIF === "Y"){
				amtUtil.checkHotWalletBalance(db, dbReq[0].coinType);
			}
			
			
			routeUtil.after(req,res, {
				res: {msg:"approve success"},
				redirectQuery: "/?request=requests&status=success"
			});
		} catch (err) {
			logger.error("/approveWithdrawal - " + err.stack);
			routeUtil.after(req,res,{
				res: {error: "Error approving request"},
				redirectQuery: "/?request=requests&status=fail"
			});
		}
	});

	/**
	 * Marks the withdraw requests as rejected
	 */
	app.post("/rejectWithdrawal",[isLoggedIn, hasPermissionAction], async (req, res) => {
		try{
			let requestIds = req.body.data.map(x => ObjectID(x));
			logger.debug("/rejectWithdrawal - rejecting withdrawals with ID " + JSON.stringify(requestIds));

			let dbReq = await db.collection("withdraw_request").find({_id:{$in:requestIds}, approvedStatus: "P", sentAmount:false}).toArray();
			logger.debug(`/rejectWithdrawal - request ids: ${requestIds.length} && db ids: ${dbReq.length}` );
			if(dbReq.length !== requestIds.length){
				routeUtil.after(req,res,{
					res: {error: "Passed Request ID not valid for rejection"},
					redirectQuery: "/?request=reject&status=fail"
				});
				return;
			}
			
			await db.collection("withdraw_request").update(
				{_id:{$in:requestIds}},
				{$set:{approvedStatus: "R"}},
				{multi: true}
			);
			
			routeUtil.after(req,res, {
				res: {msg:"reject success"},
				redirectQuery: "/?request=reject&status=success"
			});
		} catch (err) {
			logger.error("/rejectWithdrawal - " + err.stack);
			routeUtil.after(req,res,{
				res: {error: "Error rejecting request"},
				redirectQuery: "/?request=reject&status=fail"
			});
		}
	});

	/**
	 * Approves the rejected withdraw requests
	 */
	app.post("/approveRejectedWithdrawal",[isLoggedIn, hasPermissionAction], async (req, res) => {
		try{
			let requestIds = req.body.data.map(x => ObjectID(x));
			logger.debug("/approveRejectedWithdrawal - approving withdrawals with ID " + JSON.stringify(requestIds));

			let dbReq = await db.collection("withdraw_request").find({_id:{$in:requestIds}, approvedStatus: "R", sentAmount:false}).toArray();
			logger.debug(`/approveRejectedWithdrawal - request ids: ${requestIds.length} && db ids: ${dbReq.length}` );
			if(dbReq.length !== requestIds.length){
				routeUtil.after(req,res,{
					res: {error: "Passed Request ID not valid for approval"},
					redirectQuery: "/?request=reject&status=fail"
				});
				return;
			}
			
			await db.collection("withdraw_request").update(
				{_id:{$in:requestIds}},
				{$set:{approvedStatus: "A"}},
				{multi: true}
			);
			
			routeUtil.after(req,res, {
				res: {msg:"approve success"},
				redirectQuery: "/?request=reject&status=success"
			});
		} catch (err) {
			logger.error("/approveRejectedWithdrawal - " + err.stack);
			routeUtil.after(req,res,{
				res: {error: "Error rejecting request"},
				redirectQuery: "/?request=reject&status=fail"
			});
		}
	});

}

const getWithdrawTxns = async (db, coinType, after) => {
	let txns = await db.collection("transaction").find({txnType:"W", coinType, timeStamp: {$gte:after}}, 
		{fields: {status:1, recepient:1, amount:1, txnHash:1, manualResend:1, createTime:1, timeStamp:1, nonce:1, trace:1}}
	).toArray();
	
	let cnt = 0;
	txns.forEach((txn) => {
		if(!txns[cnt].timeStamp)
			txns[cnt].timeStamp = 0;
		else 
			txns[cnt].timeStamp = txns[cnt].timeStamp * 1000;
		cnt++;
	});

	return txns;
};

const getWithdrawRequests = async (db, coinType, dbquery) => {
	let approvedStatus = "P";
	switch(dbquery.data) {
		case "pending": approvedStatus = "P"; break;
		case "approved": approvedStatus = "A"; break;
		case "rejected": approvedStatus = "R"; break;
		default: approvedStatus = null;
	}
	const web3 = new Web3(new Web3.providers.HttpProvider(process.env.NODE_ETH_NETWORK));
	const findQuery = {sentAmount: false, coinType};
	if(approvedStatus) {
		findQuery.approvedStatus = approvedStatus;
	}
	let query = db.collection("withdraw_request").find(findQuery, 
		{fields: {transactions:1, totalAmount:1, estimateGas:1, approvedStatus: 1, createDt: 1, rejected: 1}}
	);

	if(dbquery.count > 0) {
		query.skip(dbquery.skip).limit(dbquery.count);
	}

	if(dbquery.sortField) {
		const sortQ = {};
		sortQ[dbquery.sortField] = dbquery.sortDir;
		query.sort(sortQ)
	}

	const resData = {};
	const requests = await query.toArray();
	var cnt = 0;
	requests.forEach((request) => {
		if(coinType === "AMTC"){
			requests[cnt].transactions = convertToAmtcArray(requests[cnt].transactions);
		}
		requests[cnt].estimateGas = process.env.ETH_LTK_SUPPORT === "Y" ? ltkUtil.gasToLianke(request.estimateGas) : web3.fromWei(request.estimateGas);
		cnt++;
	});
	resData.data = requests;

	const requestStats = await db.collection("withdraw_request").mapReduce(function() {
		const amount = parseFloat(this.totalAmount);
		emit(this.approvedStatus, { amount, count: 1});
	}, function(key, objVals) {
		reducedVal = { count: 0, amount: 0 };
		for (let val of objVals) {
			reducedVal.count += val.count;
			reducedVal.amount += val.amount;
		}
		return reducedVal;
	}, { query: findQuery, out: {inline:1} });
	if(requestStats.length > 0) {
		resData.count = requestStats[0].value.count;
		resData.totals = requestStats[0].value.amount;
	}
	resData.page = dbquery.page;
	return resData;
};

const convertToAmtcArray = (arr) => {
	let txns = arr;
	let cnt = 0;
	txns.forEach((txn) => {
		if(!txns[cnt].timeStamp)
			txns[cnt].timeStamp = 0;
		else 
			txns[cnt].timeStamp = txns[cnt].timeStamp * 1000;
		cnt++;
	});
	return txns;
};
