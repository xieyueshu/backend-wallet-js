const BigNumber = require("bignumber.js");
const crypto = require("crypto");

const rpc = require("./btc_lib/rpc");
const btcUtil = require("./btc_utils");
const dbUtil = require("./db_utils");

const logger = require("../../config/winston");

var BITCOIN_DIGITS = 8;
var BITCOIN_SAT_MULT = Math.pow(10, BITCOIN_DIGITS);
const CONFIRM_COUNT = parseInt(process.env.BTC_CONFIRMATION_COUNT) + 1; // get num of blocks after current block!

const sendOmni = async(wallet) => {
  const { toAddress, amount, fromAddress, key, feePrice } = wallet; 
  logger.debug(`sendOmni - Sending from ${fromAddress} to ${toAddress}`);
  const coin = parseInt(process.env.BTC_OMNI_TOKEN);
  const sendAmt = new BigNumber(amount);
  const payload = await rpc.call("omni_createpayload_simplesend", [coin, sendAmt.toString()]);

  const unspentList = await rpc.call("listunspent", [CONFIRM_COUNT, 999999, [fromAddress]]);
  const minFee = new BigNumber(process.env.BTC_FEE_MIN);
  let totalIn = new BigNumber(0);
  let rawIn = [], rawFee = [];
  let spendable = unspentList.filter(unspent => minFee.lte(unspent.amount));
  // go through all unspent to get more funds
  if(spendable.length === 0) {
    spendable = unspentList;
  }
  
  for(let i = 0; i < spendable.length; i++) {
    const unspent = spendable[i];
    totalIn = totalIn.plus(unspent.amount);
    rawIn.push({ txid: unspent.txid, vout: unspent.vout });
    rawFee.push({ txid: unspent.txid, vout: unspent.vout, scriptPubKey: unspent.scriptPubKey, value: unspent.amount });
    if(totalIn.gt(minFee)){
      break;
    }
  }

  if (totalIn.lt(minFee) || rawIn.length === 0) {
    logger.debug("Not enough BTC for fee. Skipping");
    return;
  } 
  try {
    const rawTxn = await rpc.call("createrawtransaction", [rawIn, {}]);
    const attachedTxn = await rpc.call("omni_createrawtx_opreturn", [rawTxn, payload]);
    const refTxn = await rpc.call("omni_createrawtx_reference", [attachedTxn, toAddress]);

    const txnSize = Buffer.byteLength(refTxn);
    // get price of each byte in satoshi
    const feeEstimate = new BigNumber(feePrice * txnSize).div(BITCOIN_SAT_MULT);
    logger.debug(`sendOmni - Omni Fee estimate: ${feeEstimate}`);

    // always send the change to the hot wallet
    const changeTx = await rpc.call("omni_createrawtx_change", [refTxn, rawFee, process.env.BTC_HOT_WALLET, feeEstimate.toNumber(), 2]);
    const signed = (await rpc.call("signrawtransaction", [changeTx, [], [key]])).hex;
    const send = await rpc.call("sendrawtransaction", [signed]);
    logger.info(`sendOmni - Successfully sent ${send} to blockchain`);
    return send;
  } catch (e) {
    logger.error(`Error sending Omni: ${e.stack}`);
    return null; 
  }
};

const sendAndSave = async(db, wallet) => {
  let savedTxn = null;
  const feePrice = await dbUtil.getGasPrice(db, "btc");
  wallet.feePrice = feePrice;
  const txid = await sendOmni(wallet);
  if(txid) {
    wallet.to = wallet.toAddress;
    wallet.from = wallet.fromAddress;
    wallet.hash = txid;
    logger.info("btc_deposit_process - inserting omni txn with hash: " + txid);
    savedTxn = await dbUtil.createAndSendTxn(db, wallet);
  }
  return savedTxn;
};

const saveWithdrawRequest = async (db, withdrawals) => {
  try {
    var coinType = withdrawals.type.toUpperCase();
    logger.info("omni_utils saveWithdrawRequest - Creating a " + coinType + " withdraw request");
    var hotAddress = await btcUtil.getBtcWithdrawWallet(coinType, db);
    let withdrawRequest = {
      hotAddress: hotAddress.address,
      sentAmount: false,
      createDt: new Date(),
      transactions: [],
      coinType
    };
    // compute gas
    let totalGas = new BigNumber(0), totalAmount = new BigNumber(0), gas = new BigNumber(process.env.BTC_FEE_MIN);
    logger.debug("Gas: " + gas.toString());
    // check each request if valid
    for (const request of withdrawals.request) {
      let { trace, amount, address } = request;
      let amt = new BigNumber(amount);
      const error = await btcUtil.checkRequest(db, request);
      if (error) {
        logger.warn(`Error in withdraw request: ${JSON.stringify(error)}`);
        return error;
      }
      let details = {
        id: crypto.randomBytes(16).toString("hex"),
        amount: amt.toString(),
        requestAddr: address,
        sent: false,
        gas: gas.toNumber(), 
        trace
      };
      logger.debug(`omni_utils saveWithdrawRequest - ${JSON.stringify(details)}`);
      withdrawRequest.transactions.push(details);
      totalAmount = totalAmount.plus(amt);
      totalGas = totalGas.plus(gas);
    }
    withdrawRequest.totalAmount = totalAmount.toString();
    withdrawRequest.estimateGas = totalGas.toNumber();
    // check if the request requires approval
    withdrawRequest.approvedStatus = dbUtil.checkWithdrawApproval(withdrawals, withdrawRequest);
    logger.debug(`omni_utils saveWithdrawRequest - ${JSON.stringify(withdrawRequest)}`);
    const item = await db.collection("withdraw_request").insert(withdrawRequest);
    let requestDetails = {
      requestId: item.ops[0]._id,
      address: hotAddress.address,
      estimateGas: totalGas,
      totalAmount
    };
    logger.info("omni_utils saveWithdrawRequest - Inserted withdraw request with ID " + requestDetails.requestId);
    return requestDetails;
  } catch (err) {
    logger.error("omni_utils saveWithdrawRequest - " + err.stack);
    return { error: "An error occurred while processing the request" };
  }
};


module.exports = {
  saveWithdrawRequest,
  sendAndSave,
  sendOmni,
  getOmniTxn: async (hash) => {
    try {
      const txn = await rpc.call("omni_gettransaction", [hash]);
      return txn;
    } catch (e) {
      logger.warn("error retrieving omni txn: " + e.stack);
      return null;
    }
  },
  getBalance: async (addr) => {
    try {
      const bal = await rpc.call("omni_getbalance", [addr, parseInt(process.env.BTC_OMNI_TOKEN)]);
      return bal;
    } catch (e) {
      logger.warn("error retrieving omni txn: " + e.stack);
      return null;
    }
  }
};

// require("dotenv").config();
// sendOmni({from: process.env.BTC_HOT_WALLET, secret: process.env.BTC_HOT_WALLET_SECRET, to: "mq5Fve2V7P9r83njyL827jRNFu1QceKvJs", amount: 1.3, feePrice: 20});