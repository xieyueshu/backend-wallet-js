// Sep 8 2020 (danie) - added support for TRX
// Oct 28 2020 (danie) - added processing of AMT asset withdraw
const Web3 = require("web3");
const BigNumber = require("bignumber.js");

const base = require("../utils/base_utils");
const etherUtil = require("../utils/eth_utils");
const ltkUtil = require("../utils/ltk_utils");
const amtUtil = require("../utils/amt_utils");
const omniUtil = require("../utils/omni_utils");
const btcUtil = require("../utils/btc_utils");
const tronUtil = require("../utils/tron_utils");
const filUtil = require("../utils/fil_utils");
const dbUtil = require("../utils/db_utils");
const logger = require("../../config/winston-job");

var isRunning = false;

const typeNoPending = ["AMT", "AMT_A"];
let lastBalanceCheck = null;
let amtAsset = null;

async function withdrawChecker(db) {
  if (!isRunning) {
    isRunning = true;
    try {
      await checkRequests(db);
      await checkHotOverflow(db);
    } catch (error) {
      logger.error("withdraw_checker_job - main program error: " + error.stack);
    }
    isRunning = false;
  } else {
    logger.debug("Skipped withdraw_checker_job run due to ongoing operation");
  }

}

const hasEnoughFunds = async (db, web3, request) => {
  if (request.coinType === "ETH" || request.coinType === "AMTC") {
    const isLtk = process.env.ETH_LTK_SUPPORT === "Y";
    // get the ETH balance 
    let weiResult = await etherUtil.getBalance(web3, request.hotAddress);
    let weiBalance = isLtk ? BigNumber(web3.fromWei(weiResult, "ether")) : new BigNumber(weiResult.toString());
    const gasRequired = await etherUtil.getGasInEth(db, web3);


    if (request.coinType === "AMTC") {
      // get the number of tokens for the address
      let tokenBalance = await etherUtil.getTokenBalance(web3, request.hotAddress);
      logger.debug(`withdraw_checker_job - tokens: ${tokenBalance.toString()} / ${request.totalAmount}, eth: ${weiBalance} / ${gasRequired}`);
      if (tokenBalance.lt(request.totalAmount) || weiBalance.lt(gasRequired)) {
        if (tokenBalance.lt(request.totalAmount))
          logger.warn("withdraw_checker_job - Not enough tokens for " + request.hotAddress + " to perform the transfer");
        else
          logger.warn("withdraw_checker_job - Not enough funds for " + request.hotAddress + " to perform the transfer");

        return false;
      }
    } else if (request.coinType === "ETH") {
      // add checking for eth + gas total
      let weiRequest = isLtk ?  request.totalAmount : web3.fromWei(request.totalAmount, "ether");
      const gas = isLtk ? ltkUtil.gasToLianke(gasRequired) : gasRequired;
      let totalWeiRequired = BigNumber(weiRequest).plus(BigNumber(gas));
      if (weiBalance.lt(totalWeiRequired)) {
        logger.warn("withdraw_checker_job - Not enough ETH for " + request.hotAddress + " to perform the transfer");
        return false;
      }
    }
  } else if (request.coinType === "AMT") {
    let hotBal = await amtUtil.getBalance(request.hotAddress);
    if (hotBal < request.totalAmount) {
      return false;
    }
  } else if (request.coinType === "AMT_A") {
    let hotBal = await amtUtil.getBalance(request.hotAddress, false);
    hotBal = hotBal.filter(b => b.assetref === amtAsset.assetref);
    if (hotBal.length === 0 || hotBal[0].qty < request.totalAmount) {
      return false;
    }
  } else if (request.coinType === "OMNI") {
    const omniBal = await omniUtil.getBalance(request.hotAddress);
    if (new BigNumber(omniBal.balance).lt(request.totalAmount)) {
      return false;
    }
    const btcBal = await btcUtil.getBalance(request.hotAddress);
    if (new BigNumber(btcBal).lt(request.estimateGas)) {
      return false;
    }
  } else if (tronUtil.isTronType(request.coinType)) {
    // Sep 9 14 2020 (danie) - added balance checking for token balance
    let hotBal =  new BigNumber(0);
    if(request.coinType === "TRX") {
      hotBal = new BigNumber(await tronUtil.getBalance(request.hotAddress));
    }	else {
      hotBal = new BigNumber(await tronUtil.getTokenBalance(request.hotAddress));
    }
    if (hotBal.lt(request.totalAmount)) return false;
    //Nov 12, 2020 zhen - added support for FIL
  } else if (request.coinType=="FIL") {				
    let hotBal =  new BigNumber(await filUtil.getBalance(request.hotAddress));
    if (hotBal.lt(new BigNumber(request.totalAmount))) return false;		
  } else {
    return false; // return false if coin type is not recognized
  }
  return true;
};

const sendRequest = async (db, request, wallet, index) => {
  try {
    logger.info("withdraw_checker_job - Sending withdraw for request with ID " + request.transactions[index].id);
    //added to prevent missing updates
    await db.collection("withdraw_request").update({
      _id: request._id,
      "transactions.id": request.transactions[index].id
    }, {
      $set: {
        "transactions.$.sent": true
      }
    });
    let sentTxn = {};
    if (request.coinType === "AMTC" || request.coinType === "ETH") {
      sentTxn = await etherUtil.send(db, wallet);
    } else if (request.coinType === "AMT") {
      sentTxn = await amtUtil.sendAmt(db, wallet);
    } else if (request.coinType === "AMT_A") {
      wallet.asset = amtAsset.assetref;
      sentTxn = await amtUtil.sendAmt(db, wallet);
    } else if (request.coinType === "OMNI") {
      const txnDet = Object.assign({}, wallet);
      txnDet.type = txnDet.use;
      txnDet.coin = request.coinType;
      sentTxn = await omniUtil.sendAndSave(db, txnDet);
    } else if (tronUtil.isTronType(request.coinType)) {
      // Sep 9 14 2020 (danie) - used tron type check
      sentTxn = await tronUtil.send(db, wallet);
      //Nov 12 2020 (zhen) - support for fil
    } else if ("FIL" == request.coinType){			
      sentTxn = await filUtil.sendFil(db,wallet);
    }
    // add the transaction 
    await db.collection("withdraw_request").update({
      _id: request._id,
      "transactions.id": request.transactions[index].id
    }, {
      $set: {
        "transactions.$.txnHash": sentTxn.txnHash
      }
    });
  } catch (err) {
    logger.error("withdraw_checker_job - withdraw send error: " + err.stack);
    logger.warn(`withdraw_checker_job - Inserting failed transaction: ${wallet.toAddress} -> ${wallet.amount}`);
    // add the transaction as one that failed
    db.collection("transaction").insert({
      status: "X",
      txnHash: "",
      manualResend: false,
      sender: wallet.fromAddress,
      recepient: wallet.toAddress,
      amount: wallet.amount,
      txnType: wallet.use,
      coinType: wallet.type,
      createTime: new Date(),
      trace: wallet.trace,
      timeStamp: 0
    }).catch(err => {
      logger.error("withdraw_checker_job - error inserting failed transaction: " + err.stack);
    });
  }
};

const verifyMarked = async (db, requestId, index) => {
  // get the record from the database again to verify this particular record has been marked as sent
  let dbRecord = await db.collection("withdraw_request").findOne({
    _id: requestId
  });
  let dbReq = dbRecord.transactions[index];

  if (!dbReq.sent) {
    logger.error("ERROR: FAILED TO MARK TRANSACTION AS SENT. EXITING THE APPLICATION");
    logger.debug("Failed: " + dbReq.requestAddr + ": " + dbReq.amount);
    // TODO: add sending of mail; try-finally with exit in finally 
    process.exit(1);
  }
};

/**
 * Checks for any withdraw requests that haven't been sent yet and performs the transfer
 * @param {db object for performing database methods} db 
 */
const checkRequests = async (db) => {
  logger.debug("withdraw_checker_job - running");
  // retrieve the approved and unsent withdraw 
  // Sep 9 2020 (danie) - fixed notIncluded to empty set 
  let notIncluded = [];
  amtAsset = base.getValueMem("asset");
  // check first if there is not enough funds in the withdraw balance for all withdraw records
  await notifyWithdrawBalance(db);
  // we send the Ambertime-related withdraw first if multi-withdraw is set-up
  if (process.env.MULTI_WITHDRAW === "Y" && process.env.USES_BIND_WALLET_WD === "Y") {
    notIncluded = ["AMT", "AMT_A", "BTC"];
    if(process.env.CHAIN_SUPPORT.includes("AMT")) {
      await sendMulti(db, "AMT");
      await sendMulti(db, "AMT_A");
    }
    if(process.env.CHAIN_SUPPORT.includes("BTC"))
      await sendMulti(db, "BTC");
  }
  let wRequests = await db.collection("withdraw_request").find({
    sentAmount: false,
    approvedStatus: "A",
    coinType: {
      $nin: notIncluded
    }
  }).toArray();
  if (wRequests.length === 0) {
    logger.debug("withdraw_checker_job - No requests to watch");
    return; // we don't do anything if there is no request to watch
  }
  let web3 = null;
  if(process.env.CHAIN_SUPPORT.includes("ETH")){
    // Sep 9 2020 (Danie) - Refactored web3 provider
    web3 = new Web3(etherUtil.WEB3_PROVIDER);
  }
  let pendingW = await dbUtil.getPendingWithdraw(db, typeNoPending);
  for (let i = 0; i < wRequests.length; i++) {
    let request = wRequests[i];
    if (typeNoPending.includes(request.coinType) && pendingW.length > 0) { // there is currently a pending withdrawal transaction
      logger.debug("withdraw_checker_job - there is an existing pending AMT transaction. Skipping request");
      continue;
    }
    // skip if there isn't enough funds
    if (!(await hasEnoughFunds(db, web3, request))) {
      logger.debug("withdraw_checker_job - Not enough funds for withdrawal. Skipping");
      continue;
    }
    // Sep 16 2020 (danie) - added checking for resources
    // Oct 08 2020 (danie) - added checking if burn energy is enabled
    if(request.coinType === "TRC20") {
      const resources = await tronUtil.checkAccountResources(request.hotAddress, "TRC20", request.transactions.length);
      if(!resources.energy && process.env.TRX_BURN_ENERGY !== "Y") {
        logger.info("Freezing TRX for energy");
        await tronUtil.freezeForAccount(db, request.hotAddress, request.transactions.length);
        continue;
      }
    }
    const tknWallet = await dbUtil.retrieveAddress(db, request.hotAddress, request.coinType, "W");
    var sent = new BigNumber(0),
      gasSent = 0;
    let hasSent = false;
    for (let j = 0; j < request.transactions.length; j++) {
      let txn = request.transactions[j];
      // retrieving again to make sure previous transactions in the same
      // request aren't pending
      pendingW = await dbUtil.getPendingWithdraw(db, typeNoPending);
      if (typeNoPending.includes(request.coinType) && pendingW.length > 0) { // there is currently a pending withdrawal transaction
        logger.debug("withdraw_checker_job - there is an existing pending AMT transaction. Skipping transaction");
        hasSent = true;
        break;
      }

      if (!txn.sent) {
        let wallet = {
          fromAddress: request.hotAddress,
          toAddress: txn.requestAddr,
          key: tknWallet.private,
          amount: txn.amount,
          use: tknWallet.use,
          type: tknWallet.type,
          trace: txn.trace
        };
        // try sending the transaction, and mark it as sent (regardless if successful or not) 
        await sendRequest(db, request, wallet, j);
        await verifyMarked(db, request._id, j);
        sent = sent.plus(new BigNumber(txn.amount)); // we take note of the amount of tokens that have been sent
        if (request.coinType === "AMT" || request.coinType === "ETH")
          gasSent += parseInt(txn.gas, 16); // we take note of the amount of gas used up

        // we just mark that the withdraw has sent something
        hasSent = true;
      }
    } // end of for loop for transactions in a request
    // deduct the sent tokens from the required tokens
    request.totalAmount = ((new BigNumber(request.totalAmount)).minus(sent));
    // deduct the gas sent from the estimated gas
    request.estimateGas = request.estimateGas - gasSent;
    logger.debug("withdraw_checker_job - Amount sent: " + sent + " " + request.coinType);

    // if all tokens have been sent out or nothing was sent (empty or all transactions sent)
    // mark the withdraw request as sent
    if (request.totalAmount.eq(BigNumber(0)) || !hasSent) {
      logger.debug(`withdraw_checker_job - marking withdraw request ${request._id} as sent`);
      request.sentAmount = true;
    }

    // update the record 
    await db.collection("withdraw_request").update({
      _id: request._id
    }, {
      $set: {
        totalAmount: request.totalAmount.toString(),
        estimateGas: request.estimateGas,
        sentAmount: request.sentAmount
      }
    });
  } // end of for loop for requests 
};

const sendMulti = async (db, type) => {
  logger.debug("Sending out multi for " + type);
  let pendingW = await dbUtil.getPendingWithdraw(db, type);
  // do not send out withdraw if there is pending to avoid invalidation
  // of the transaction
  if (pendingW.length > 0){
    logger.info("No multi withdraw for " + type);
    return;
  }
  let wRequests = await dbUtil.getPendingWithdrawRequest(db, type);
  let hotBal = 0;
  if(type === "AMT" || type === "AMT_A") {
    hotBal = await amtUtil.getBalance(process.env.AMT_HOT_WALLET, type === "AMT");
  } else {
    hotBal = await btcUtil.getBalance(process.env.BTC_HOT_WALLET);
  }
  let total = 0,
    inputs = [],
    sent = [];
  for (let i = 0; i < wRequests.length; i++) {
    let request = wRequests[i];
    let reqAmt = BigNumber(request.totalAmount).toNumber();
    logger.info(`hot wallet Balance: ${hotBal}, totalReq: ${total + reqAmt}`);
    if ((total + reqAmt) > hotBal) continue;
    inputs = inputs.concat(request.transactions.map(m => {
      return {
        address: m.requestAddr,
        amount: BigNumber(m.amount).toNumber(),
        trace: m.trace
      };
    }));
    sent.push(request._id);
    total += reqAmt;
  }
  if (inputs.length > 0) {
    await sendOutMulti(db, inputs, sent, type);
  }
};

const sendOutMulti = async (db, inputs, sent, type) => {
  const hotWalletType = type === "AMT_A" ? "AMT" : type;
  const wallet = {
    type,
    inputs,
    fromAddress: process.env[hotWalletType + "_HOT_WALLET"],
    key: process.env[hotWalletType + "_HOT_WALLET_SECRET"],
    use: "W",
    multi: true,
    notAllBalance: true,
  };
  await updateRequests(db, sent, {
    "sentAmount": true
  });
  try {
    let txns = [];
    if(type === "AMT" || type === "AMT_A") {
      txns = await amtUtil.sendAmt(db, wallet);
    } else {
      txns = await btcUtil.sendBtc(db, wallet);
    }
    const txnHash = txns[0].txnHash;
    await updateRequests(db, sent, {
      "totalAmount": 0,
      "transactions.$[].txnHash": txnHash
    });
  } catch (e) {
    logger.error(`withdraw_checker_job - error on multi-send: ${e.stack}`);
  }
};

const updateRequests = (db, ids, set) => {
  return db.collection("withdraw_request").update({
    _id: {
      $in: ids
    }
  }, {
    $set: set
  }, {
    multi: true
  });
};

const checkHotOverflow = async (db) => {
  const blockchain = process.env.CHAIN_SUPPORT;
  const limit = parseFloat(process.env.AMT_HOT_WALLET_LIMIT);
  const pendingW = await dbUtil.getPendingWithdraw(db, "AMT");
  if (blockchain.includes("AMT") && pendingW.length === 0 && limit && limit >= 0) {
    const balance = await amtUtil.getBalance(process.env.AMT_HOT_WALLET);
    if (balance > limit) {
      logger.info("Hot wallet amount exceeds limit. Transferring to cold wallet.");
      let wallet = {
        fromAddress: process.env.AMT_HOT_WALLET,
        toAddress: process.env.AMT_COLD_WALLET,
        key: process.env.AMT_HOT_WALLET_SECRET,
        amount: balance - limit,
        use: "T",
        type: "AMT",
      };
      await amtUtil.sendAmt(db, wallet);
    }
  }
};

const notifyWithdrawBalance = async (db) => {
  if(process.env.WITHDRAW_BALANCE_NOTIF !== "Y") return;
  // check the balance to send to the mail every hour
  if(!lastBalanceCheck || new Date() - lastBalanceCheck > 3600000) {
    // for now, we only implement the AMT_A checking
    await amtUtil.checkHotWalletBalance(db, "AMT_A");
    lastBalanceCheck = new Date();
  }
};

module.exports = {
  start: (db) => {
    let millisInterval = parseInt(process.env.WITHDRAW_INTERVAL) * 1000;
    logger.debug("Starting up withdraw_checker_job. Interval: " + millisInterval);
    setInterval(withdrawChecker, millisInterval, db);
  },
  testCheckRequest: (db) => {
    return checkRequests(db);
  },
  testHotOverflow: (db) => {
    return checkHotOverflow(db);
  }
};