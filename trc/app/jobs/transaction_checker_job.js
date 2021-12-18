// Sep 8 2020 (danie) - added support for TRX
const Web3 = require("web3");

const BigNumber = require("bignumber.js");

const secUtil = require("../utils/security_utils");
const etherUtil = require("../utils/eth_utils");
const amtUtil = require("../utils/amt_utils");
const btcUtil = require("../utils/btc_utils");
const httpUtil = require("../utils/http_utils");
const dbUtil = require("../utils/db_utils");
const tronUtil = require("../utils/tron_utils");
const filUtil = require("../utils/fil_utils");
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
      // Sep 9 2020 (Danie) - Refactored web3 provider
      web3 = new Web3(etherUtil.WEB3_PROVIDER);
      // get the latest block number
      ethBlockNum = await etherUtil.getLatestBlock(web3);
    }
    for (let i = 0; i < txns.length; i++) {
      let txn = txns[i];
      if (!txn.txnHash)
        continue; //skip the transaction if the hash is blank
      // Sep 9 14 2020 (danie) - used tron type check
      if (txn.coinType === "AMTC" || txn.coinType === "ETH")
        await checkEthTxn(db, web3, ethBlockNum, txn);
      else if (txn.coinType === "AMT" || txn.coinType === "AMT_A")
        await checkAmtTxn(db, txn);
      else if (txn.coinType === "FIL")
        await checkFilTxn(db, txn);
      else if (txn.coinType === "BTC" || txn.coinType === "OMNI")
        await checkBtcTxn(db, txn);
      else if (tronUtil.isTronType(txn.coinType)) 
        await checkTrxTxn(db, txn);
    }

    // Sep 19 2020 (danie) - Added unfreeze if there are any that have passed the freezing period
    if(process.env.CHAIN_SUPPORT.includes("TRX")) {
      await tronUtil.unfreezeBalance(db);
    }
  } catch (err) {
    logger.error("transaction_checker_job - error: " + err.stack);
  }

};

const checkEthTxn = async (db, web3, blockNum, txn) => {
  const currTime = new Date().getTime();
  let receipt = await etherUtil.getReceipt(web3, txn.txnHash);
  // if the transaction has a receipt, it is no longer pending
  if (receipt) {
    // check the number of block confirmations
    if (blockNum - receipt.blockNumber >= parseInt(process.env.ETH_CONFIRMATION_COUNT)) {
      if (parseInt(receipt.status, 16) === 1) {
        logger.info("transaction_checker_job - Found successful transaction: " + txn.txnHash);
        const chainTxn = await web3.eth.getTransaction(txn.txnHash);
        // include the record in those to be marked as "successful"
        txn.gas = etherUtil.getGasUsedUp(web3, receipt, chainTxn);
        txn.blockNumber = receipt.blockNumber;
        txn.timeStamp = (await etherUtil.getBlock(web3, receipt.blockNumber)).timestamp;
        db.collection("transaction").findOneAndUpdate({
          _id: txn._id
        }, {
          $set: {
            status: "L",
            gas: txn.gas,
            timeStamp: txn.timeStamp,
            blockNumber: receipt.blockNumber,
          }
        });
        // Oct 09 2020 (danie) - created approve record when approve is completed
        if (txn.txnType === "D" || txn.txnType === "W"){
          // then we notify the client of the successful transaction (only withdraw or deposit; no transfers)
          httpUtil.sendTransaction(txn, db);
        } else if (txn.txnType === "APPROVE") { 
          await db.collection("approved_address").insert({spender: txn.recepient, approver: txn.sender, status: "L"});
          logger.info(`transaction_checker_job - created approve transaction for ${txn.sender}`);
        }
      } else {
        // if the transaction failed, we resend it (receipt status is not 1)
        logger.error("transaction_checker_job - transaction " + txn.txnHash + " failed");
        if (process.env.RESEND_TRANSACTION === "Y") {
          await resend(db, txn);
        } else {
          txn.status = "X";
          await db.collection("transaction").findOneAndUpdate({_id: txn._id}, {
            $set: { status: txn.status, timeStamp: 0, manualResend: false}
          });
          await resetDepositUnsent(db, txn);
        }
      }
    }
  } else {
    let timePassed = (currTime - txn.createTime.getTime()) / 1000;
    logger.debug("transaction_checker_job - Time passed: " + timePassed);

    //if there is nonce but no receipt yet, the transaction may not have been sent properly
    if (timePassed > parseInt(process.env.ETH_PENDING_WAIT)) {
      // if the pending time for the transaction exceeds the expected time, we resend the transaction
      // Sep 21 2020 (danie) - fixed variable name typo
      logger.error("transaction_checker_job - transaction did not respond after " + timePassed);
      if (process.env.RESEND_TRANSACTION === "Y")
        await resend(db, txn);
    }
  }
};

const resetDepositUnsent = async (db, txn) => {
  const dbTxn = await db.collection("transaction").findOne({_id: txn._id}); 
  if(dbTxn.txnType !== "T" || dbTxn.status !== "X") return;
  
  // get deposit to reset the unsent amount
  const depositAddr = await db.collection("address").findOne({address: txn.sender, use: "D", type: txn.coinType});
  if(!depositAddr) return;
  /*await db.collection("address").findOneAndUpdate({_id: depositAddr._id}, {$inc: { unsent: txn.amount }});
  logger.info(`Added ${txn.amount} to unsent of address ${depositAddr.address}`);*/
  const resetLimit = parseInt(process.env.COLLECTION_RETRY_COUNT || -1);
  if(resetLimit === -1 || depositAddr.unsentReset < resetLimit) {
    await db.collection("address").findOneAndUpdate({_id: depositAddr._id}, {$inc: { unsent: txn.amount, unsentReset: 1 }});
    logger.info(`Added ${txn.amount} to unsent of address ${depositAddr.address}`);
  } else {
    await db.collection("address").findOneAndUpdate({_id: depositAddr._id}, {$set: { unsentReset: 0, unsentSkip: true}});
    logger.info(`Collection retry count has been met. Skipping address ${depositAddr.address} reset.`);
  }
};

const checkAmtTxn = async (db, txn) => {
  const currTime = new Date().getTime();
  let rawTxn = await amtUtil.getRawTransaction(txn.txnHash);
  if (rawTxn && rawTxn.confirmations >= parseInt(process.env.AMT_CONFIRMATION_COUNT)) {
    logger.info("transaction_checker_job - Found successful transaction: " + txn.txnHash);
    const block = await amtUtil.getBlock(rawTxn.blockhash);
    // include the record in those to be marked as "successful"
    txn.timeStamp = rawTxn.time;
    txn.blockNumber = block.height;
    db.collection("transaction").findOneAndUpdate({
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
      logger.error("transaction_checker_job - transaction did not respond after " + timePassed);
      if (process.env.RESEND_TRANSACTION === "Y")
        await resend(db, txn);
    }
  }
};

const checkTrxTxn = async (db, txn) => {
  const currTime = new Date().getTime();
  let rawTxn = await tronUtil.getTransactionInfo(txn.txnHash);
  if (isSuccessTransaction(txn, rawTxn)) {
    logger.info("transaction_checker_job - Found successful transaction: " + txn.txnHash);
    txn.timeStamp = rawTxn.blockTimeStamp/1000;
    txn.blockNumber = rawTxn.blockNumber;
    db.collection("transaction").findOneAndUpdate({
      _id: txn._id
    }, {
      $set: {
        status: "L",
        timeStamp: txn.timeStamp,
        blockNumber: rawTxn.blockNumber
      }
    });
    // Sep 16 2020 (danie) - Added auto-transfer of activated trx
    // Oct 26 2020 (danie) - Fixed bug in updating unsent of address
    if (txn.txnType === "D" || txn.txnType === "W" || txn.txnType === "S") {
      if(txn.txnType === "D") {
        const depositAmount = new BigNumber(txn.amount).toNumber(); 
        await db.collection("address").findOneAndUpdate({address: txn.recepient}, {$inc: { unsent : depositAmount }});
        logger.info(`Added ${txn.amount} ${txn.coinType} unsent to address ${txn.recepient}`);
      }
      // then we notify the client of the successful transaction (only withdraw or deposit or send; no internal transfers)
      httpUtil.sendTransaction(txn, db);
    } else if (txn.txnType === "ACTIVATE") { // transfer out activation TRX to hot wallet
      const key = (await db.collection("address").findOne({address: txn.recepient})).private;
      const wallet = {
        fromAddress: txn.recepient,
        toAddress: process.env.TRX_HOT_WALLET,
        key: secUtil.decryptKey(key),
        amount: txn.amount,
        use: "T",
        type: txn.coinType
      };
      logger.debug(`tron_utils.checkTrxTxn - transferring ${txn.amount} from ${txn.recepient} to hot wallet`);
      await tronUtil.send(db, wallet);
    }
  } else {
    let timePassed = (currTime - txn.createTime.getTime()) / 1000;
    logger.debug("transaction_checker_job - Time passed: " + timePassed + "; status: " + rawTxn.result);
    const isFailTxn = rawTxn && rawTxn.result === "FAILED";
    //if there is nonce but no receipt yet, the transaction may not have been sent properly
    if (timePassed > parseInt(process.env.TRX_PENDING_WAIT) || isFailTxn) {
      // if the pending time for the transaction exceeds the expected time, we resend the transaction
      logger.error("transaction_checker_job - has failed / transaction did not respond after " + timePassed);
      if (process.env.RESEND_TRANSACTION === "Y")
        await resend(db, txn);
    }
  }
};

function isSuccessTransaction(dbTxn, rawTxn) {
  // check if rawtxn is existing and has a blocknumber
  if(rawTxn && rawTxn.blockNumber) {
    // if TRX coin and has blocknumber, it is already successful
    if (dbTxn.coinType === "TRX") return true;
    
    // if contract type, check the receipt result if successful
    return rawTxn.receipt.result === "SUCCESS";
  }
  return false;
}

const checkFilTxn = async (db, txn) => {
  if (!txn.checked){	   	
    let rawTxn = await filUtil.getTransactionInfo(txn.txnHash);
    if (rawTxn && rawTxn.blockNumber) {
      if (rawTxn.success){
        txn.blockNumber = rawTxn.blockNumber;
        txn.gas = rawTxn.gasFee;
        txn.checked=true;
      } else {
        db.collection("transaction").findOneAndUpdate({
          _id: txn._id
        }, {
          $set: {
            status: "X",				
            blockNumber: rawTxn.blockNumber,
            gas: rawTxn.gasFee,
            manualResend: false
          }
        });
      }				
    }
  }
  if (txn.checked){ 
    logger.info("transaction_checker_job - Found successful transaction: " + txn.txnHash);
    db.collection("transaction").findOneAndUpdate({
      _id: txn._id
    }, {
      $set: {
        status: "L",				
        blockNumber: txn.blockNumber,
        gas: txn.gas,
        checked: txn.checked
      }
    });

    if (txn.txnType === "D" || txn.txnType === "W" || txn.txnType === "S") {
      // then we notify the client of the successful transaction (only withdraw or deposit or send; no internal transfers)
      httpUtil.sendTransaction(txn, db);
      if(txn.txnType === "D") {
        const dbAddress = await db.collection("address").findOne({address: txn.recepient});
        const unsent = new BigNumber(dbAddress.unsent || 0).plus(txn.amount).toNumber(); 
        await db.collection("address").findOneAndUpdate({address: txn.recepient}, {$set: {unsent}});
      }
    } 
  } 
};

const checkBtcTxn = async (db, txn) => {
  const currTime = new Date().getTime();
  let rawTxn = await btcUtil.getTxn(txn.txnHash);
  if (rawTxn && rawTxn.confirmations >= parseInt(process.env.BTC_CONFIRMATION_COUNT)) {
    logger.info("transaction_checker_job - Found successful transaction: " + txn.txnHash);
    txn.fees = await btcUtil.getFees(db, rawTxn);
    if (!txn.sender) {
      txn.sender = await btcUtil.getTxnSender(rawTxn);
    }
    txn.blockNumber = rawTxn.height; 
    // include the record in those to be marked as "successful"
    await db.collection("transaction").findOneAndUpdate({
      _id: txn._id
    }, {
      $set: {
        status: "L",
        timeStamp: rawTxn.time,
        sender: txn.sender,
        fees: txn.fees,
        blockNumber: rawTxn.height
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
};

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
  } else {
    // for all other cases, we mark the transaction as cancelled
    resendThreshold = BigNumber(0);
    resendLimit = 0;
    txnAmt = BigNumber(txn.amount);
  }
  logger.info(`Attempting to resend transaction ${txn.txnHash}`);
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
          resend = await etherUtil.send(db, wallet, null, false);
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
    await resetDepositUnsent(db, txn);
  } catch (err) {
    logger.error("transaction_checker_job - transaction_checker_job resend error: " + err.stack);
  }
  // We return true since the transaction was sent successfully
  return true;
};

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