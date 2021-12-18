// Oct 7 2020 (danie) - added separate process for deposit
require("dotenv").config();

const MongoClient = require("mongodb").MongoClient;
const db = require("../../config/db");

const dbUtil = require("../utils/db_utils");
const tronUtil = require("../utils/tron_utils");
const logger = require("../../config/winston");
const loggerEvent = require("../../config/winston-events");
const crypto = require("crypto");

global.APP_HASH = process.argv[2];
global.SHARED_KEY = process.argv[3];
if(!process.argv[4] || isNaN(process.argv[4])) {
  logger.warn("No block number provided for trx deposit process.");
  if(process.send) {
    process.send(JSON.stringify({block:null, status:"ERROR"}));
  } else {
    process.exit(0);
  }
}
const blockNum = parseInt(process.argv[4]);
// TEST!!
if(!global.APP_HASH) {
  global.APP_HASH = crypto.createHash("md5").update("pass").digest("hex");
}

MongoClient.connect(db.url, async (err, database) => {
  if (err) {
    logger.error("Unable to connect to database - " + err.stack);
    return;
  }
  const walletDb = database.db(db.name);
  let status = "DONE";
  try {
    await processBlock(walletDb, blockNum);
    await processBlockEvents(walletDb, blockNum);
  } catch (e) {
    // Oct 27 29 2020 (danie) - removed json stringify which may have caused process to not send status 
    logger.error(`trx_deposit_process - error while retrieving block ${blockNum}: ${e}`);
    status = "ERROR";
  }
  await database.close();
  if(process.send) {
    process.send(JSON.stringify({block:blockNum, status}));
  } else {
    process.exit(0);
  }
});

// sleep function

const processBlock = async (db, blockNum) => {
  var dBDeposit = await dbUtil.getTxnHashList(db, ["TRX"], ["D", "ENERGY", "ACTIVATE"]);
  const trxAddrList = await dbUtil.getDepositAddr(db, "TRX");
  if(trxAddrList.length === 0) return;
  const txnList = await tronUtil.getTransactionList(blockNum, blockNum); // process the block passed
  for(let txn of txnList) {
    if(dBDeposit.includes(txn.hash)) continue;
    if(!(txn.contractType === 1 && trxAddrList.includes(txn.toAddress))) continue;     
    const coin = "TRX", amount = tronUtil.getActualAmount(txn.amount);
    txn.amount=amount;
    txn.from = txn.ownerAddress;
    txn.blockNumber = txn.block;
    txn.timeStamp = txn.timestamp/1000;
    logger.debug("creating TRX deposit : " + txn.hash);
    insertPendingTxn(db,txn,{amount,coin, to:txn.toAddress});
  }
};

const processBlockEvents = async (db, blockNum) => {
  var dBDeposit = await dbUtil.getTxnHashList(db, ["TRC20"], ["D", "ENERGY", "ACTIVATE"]);
  const trcAddrList = await dbUtil.getDepositAddr(db, "TRC20");
  if(trcAddrList.length === 0) return;
  const  eventList = await tronUtil.getEventForBlock(blockNum);
  logger.info(`Found ${eventList.length} events for block ${blockNum}`);
  for(let txn of eventList) {
    if(dBDeposit.includes(txn.hash)) continue;
    const amount = tronUtil.fromRawContractAmt(txn.result.value || txn.result.tokens);
    const toAddress = tronUtil.addressFromHex(txn.result.to);
    if(!trcAddrList.includes(toAddress)) continue;
    const coin = "TRC20";
    const txnDetails = {
      amount,
      from: tronUtil.addressFromHex(txn.result.from),
      hash: txn.transaction_id,
      timeStamp: txn.block_timestamp,
      blockNumber: blockNum
    };
    logger.debug(`creating deposit : ${txnDetails.hash} with amount ${amount}`);
    insertPendingTxn(db, txnDetails, { amount, coin, to: toAddress});
  }
};

const insertPendingTxn = async (db, txn, det) => {
  let txnDetails = {
    txnType: txn.type || "D",
    coinType: txn.coin || det.coin,
    sender: txn.from,
    recepient: det.to || txn.to,
    amount: txn.amount || det.amount,
    createTime: new Date(),
    gas: txn.gas || 0,
    nonce: txn.nonce || 0,
    txnHash: txn.hash,
    status: "P",
    timeStamp: txn.timeStamp || 0,
    blockNumber: txn.blockNumber || 0,
    trace: txn.trace || ""
  };
  logger.info("trx_deposit_process - inserting trx deposit with hash: " + txn.hash);

  await db.collection("transaction").insert(txnDetails);
};
