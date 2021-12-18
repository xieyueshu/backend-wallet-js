const ObjectID = require("mongodb").ObjectID;

const httpUtil = require("../utils/http_utils");
const ethUtil = require("../utils/eth_utils");
const amtUtil = require("../utils/amt_utils");
const tronUtil = require("../utils/tron_utils");
const routeUtil = require("../utils/route_utils");
const secUtil = require("../utils/security_utils");
const dbUtil = require("../utils/db_utils");
const logger = require("../../config/winston");
const {isLoggedIn, hasPermissionAction} = require("../utils/route_utils");

module.exports = function(app, db) {
  /**
   * for testing - inserts any transaction received into the database
   */
  app.post("/receive-transaction", (req, res) => {
    let txn = req.body;
    delete txn._id;
    txn.sendTime = new Date();
    logger.debug("/recieve-transaction - Added successful transaction: " + req.body.txnHash);
    db.collection("success").insert(txn);
    res.send(req.body);
  });
    
  /**
   * returns the transactions queried for 
   * supports: txnHash, id, date, type
   */
  app.get("/getTransaction", async (req, res) => {
    let dbquery = req.query;
    let count = parseInt(dbquery.count || 0);
    let page = parseInt(dbquery.page || 1);
    let sortField = dbquery.sort;
    let sortDir = (dbquery.sortDir === "asc") ? 1 : -1;
    let skip = (page - 1) * count;
    delete dbquery.count;
    delete dbquery.page;
    delete dbquery.sort;
    delete dbquery.sortDir;

    
    if(Object.keys(dbquery).includes("coinType")) {
      if(amtUtil.isAmtAsset(dbquery.coinType)){
        dbquery.coinType = "AMT_A";
      } else if (tronUtil.isTrcToken(dbquery.coinType)) {
        dbquery.coinType = "TRC20";
      }
    }
    Object.keys(dbquery).forEach(k => {
      if(dbquery[k] === "true") {
        dbquery[k] = true;
      } else if(dbquery[k] === "false") {
        dbquery[k] = false;
      }
      if(k === "txnHash") {
        dbquery[k] = { $regex: dbquery[k] };
      }
    });
    const totalArray = await db.collection("transaction").mapReduce(function() {
      const amount = parseFloat(this.amount);
      // use float amount in getting total sum
      // eslint-disable-next-line no-undef
      emit("totalAmount", amount);
    }, function(key, values) {
      return Array.sum(values);
    }, { query: dbquery, out: {inline:1} });
    let totalAmount = 0;
    if(totalArray.length > 0) {
      totalAmount = totalArray[0].value;
    }
    
    const txnCursor = db.collection("transaction").find(dbquery);
    const recordCnt = await txnCursor.count();
    if (count > 0 && skip >= 0) {
      txnCursor.limit(count).skip(skip);
    }
    if(sortField) {
      const sortQ = {};
      sortQ[sortField] = sortDir;
      txnCursor.sort(sortQ);
    }
    try {
      const txnList = await txnCursor.toArray();
      if(txnList)	{
        for (const txn of txnList) {
          if(txn.coinType === "TRC20" && process.env.TRX_USE_CONTRACT_SYMBOL === "Y") txn.coinType = process.env.TRX_CONTRACT_SYMBOL;
        }
        res.send({data: txnList, count: recordCnt,  totals: totalAmount, page});
      }
      else
        res.send({"msg": "No transactions", count: 0});
    } catch (err) {
      res.send({error: "An error occurred"});
      logger.error(err.stack);
    }
  });

  /**
   * for testing - generate the wallet signature for transactions
   */
  app.post("/sign-transaction", (req, res) => {
    if(process.env.NODE_ENV !== "development") return res.status(503).send();
    let txn = req.body;
    logger.debug("sign transaction - " + JSON.stringify(txn));
    let rawSign = txn.sender + txn.recepient + txn.txnHash + txn.amount;
    if (process.env.MULTIPLE_COIN === "Y") {
      rawSign += txn.coinType;
    }
    if (txn.fees) {
      rawSign += txn.fees;
    }
    res.send(secUtil.sign(rawSign));
  });
    
  /**
   * for testing - generate the wallet signature for any request
   */
  app.post("/sign", (req, res) => {
    if(process.env.NODE_ENV !== "development") return res.status(503).send();
    let data = req.body;
    let raw = secUtil.createRaw(data);
    res.send(secUtil.sign(raw));
  });

  /**
   * for testing - validate the signature
   */
  app.post("/validate", (req, res) => {
    if(process.env.NODE_ENV !== "development") return res.status(503).send();
    res.send(secUtil.validateSignature(req.body));
  });

  /**
   * Creates a new withdraw request for the transactions to be re-sent
   */
  app.post("/resendFailedTransaction", [isLoggedIn, hasPermissionAction], async (req, res) => {
    try{
      let coinType = req.body.coinType.toUpperCase();
      let resendIds = req.body.data.map(x => ObjectID(x));
      logger.debug("/resendFailedTransaction - resending transactions with ID " + JSON.stringify(resendIds));

      let dbRes = await db.collection("transaction").find({_id:{$in:resendIds}, status: "X", manualResend:false, coinType}).toArray();
      logger.debug(`/approveWithdrawal - request ids: ${resendIds.length} && db ids: ${dbRes.length}` );
      if(dbRes.length !== resendIds.length){
        routeUtil.after(req, res, {
          res: {error: "Passed transaction ID not allowed for resending"},
          redirectQuery: "/?request=failed&status=fail"
        });
        return;
      }

      let resendTxns = await db.collection("transaction").find({_id:{$in:resendIds}}).toArray();
      const request = resendTxns.map(txn => {
        return {
          address: txn.recepient,
          amount: txn.amount,
          trace: txn.trace
        };
      });
      let withdrawals = {
        type: coinType,
        approved: true,
        request
      };
      logger.debug("/resendFailedTransaction - new withdrawal request: " + JSON.stringify(withdrawals));
      
      const afterWithdrawCall = async (details) => {
        logger.info("/resendFailedTransaction - withdraw response: " + JSON.stringify(details));
        if(!details.error) {
          await db.collection("transaction").update(
            {_id:{$in:resendIds}},
            {$set:{manualResend: true, resendDate: new Date()}},
            {multi: true}
          );
        }
        routeUtil.after(req,res,{
          res: details,
          redirectQuery: "/?request=failed&status=success"
        });
      };

      if(coinType === "ETH" || coinType === "AMTC") {
        ethUtil.createEthWithdrawRequest(withdrawals, db, function(details){
          afterWithdrawCall(details);
        });			
      } else if (coinType === "AMT" || coinType === "AMT_A") {
        amtUtil.createAmtWithdrawRequest(withdrawals, db, function(details){
          afterWithdrawCall(details);
        });
      } else if (coinType === "TRX" || coinType === "TRC20") {
        tronUtil.createWithdrawRequest(withdrawals, db, function(details){
          afterWithdrawCall(details);
        });
      } else {
        routeUtil.after(req,res,{
          res: {error: "Resending for other coin types is not supported", code: "NOT_SUPPORTED"},
          redirectQuery: "/?request=failed&status=fail"
        });
      }
    } catch (err) {
      logger.error("/resendFailedTransaction - " + err.stack);
      routeUtil.after(req,res,{
        res: {error: "Error resending failed transactions"},
        redirectQuery: "/?request=failed&status=fail"
      });
    }
  });

  /**
   * Marks pending transactions as failed 
   */
  app.post("/failPendingTransaction", [isLoggedIn, hasPermissionAction], async (req, res) => {
    try{
      let failIds = req.body.data.map(x => ObjectID(x));
      logger.debug("/failPendingTransaction - failing transactions with ID " + JSON.stringify(failIds));

      let cancelTxns = await db.collection("transaction").find({_id:{$in:failIds}, status: "P"}).toArray();
      logger.debug(`/failPendingTransaction - transaction ids: ${failIds.length} && db ids: ${cancelTxns.length}` );
      if(cancelTxns.length !== failIds.length){
        routeUtil.after(req,res,{
          res: {error: "Passed transaction ID can't be marked as failed"},
          redirectQuery: "/?request=reject&status=fail"
        });
        return;
      }
      
      await cancelTrans(db, cancelTxns, req.body);
      
      routeUtil.after(req,res, {
        res: {msg:"success marking failed"},
        redirectQuery: "/?request=reject&status=success"
      });
    } catch (err) {
      logger.error("/failPendingTransaction - " + err.stack);
      routeUtil.after(req,res,{
        res: {error: "Error marking transaction as failed"},
        redirectQuery: "/?request=reject&status=fail"
      });
    }
  });
  
  /**
   * Marks failed transaction as successful 
   */
  app.post("/forceCompleteTransaction", [isLoggedIn, hasPermissionAction], async (req, res) => {
    try{
      if(req.body.data.length > 1){
        return res.send({error: "Can only complete one transaction at a time."});
      }
      let failIds = ObjectID(req.body.data[0]);
      logger.debug("/forceCompleteTransaction - completing transactions with ID " + failIds);

      let failedTxn = await db.collection("transaction").findOne({_id:failIds, status: "X"});
      if(!failedTxn){
        routeUtil.after(req,res,{
          res: {error: "Passed transaction ID can't be marked as success"},
          redirectQuery: "/?request=reject&status=fail"
        });
        return;
      }
      
      await db.collection("transaction").updateOne({_id: failIds}, {$set:{status:"L", txnHash: req.body.hash}});

      failedTxn.txnHash = req.body.hash;
      failedTxn.status = "L";
      await httpUtil.sendTransaction(failedTxn);

      routeUtil.after(req,res, {
        res: {msg:"Success marking completed"},
        redirectQuery: "/?request=reject&status=success"
      });
    } catch (err) {
      logger.error("/forceCompleteTransaction - " + err.stack);
      routeUtil.after(req,res,{
        res: {error: "Error marking transaction as completed"},
        redirectQuery: "/?request=reject&status=fail"
      });
    }
  });
};

const cancelTrans = async (db, trans, body) => {
  for(let i = 0 ; i < trans.length; i++){
    let txn = trans[i];
    // if the transaction is the one with that nonce and address
    // we cancel it on etherscan
    if(!await dbUtil.hasSameNonce(txn.sender, txn.nonce, db)){
      try{
        let gas = parseInt(process.env.ETH_GAS_CANCEL_PRICE);
        if(body.gas){
          gas = body.gas;
        } 
        logger.debug("/failPendingTransaction - gas for replacement: " + gas);
        let tknWallet = await dbUtil.retrieveAddress(db, txn.sender);
        let wallet = { 
          fromAddress: tknWallet.address,
          toAddress: tknWallet.address,
          key: tknWallet.private,
          amount: 0,
          use: "T",
          type: "ETH",
          nonce: txn.nonce,
          gas
        };
        logger.info("/failPendingTransaction - Cancelling txn with hash" + txn.txnHash);
        await ethUtil.send(db, wallet, null);
      } catch (err){
        logger.warn("Unable to send cancelling transaction");
        logger.error(err);
      }
    }
    await db.collection("transaction").update(
      {_id:txn._id},
      {$set:{status: "X", manualResend: false}});
  }
};