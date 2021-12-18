// Oct 7 2020 (danie) - added separate process for deposit
require("dotenv").config();

const MongoClient = require("mongodb").MongoClient;
const db = require("../../config/db");

const dbUtil = require("../utils/db_utils");
const tronUtil = require("../utils/tron_utils");
const logger = require("../../config/winston");
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
  var dBDeposit = await dbUtil.getTxnHashList(db, ["TRX", "TRC20"], ["D", "ENERGY", "ACTIVATE"]);
  const trxAddrList = await dbUtil.getDepositAddr(db, "TRX");
  const trcAddrList = await dbUtil.getDepositAddr(db, "TRC20");
  const txnList = await tronUtil.getTransactionList(blockNum, blockNum); // process the block passed
  for(let txn of txnList) {
    let coin = "", amount = "";
    if(dBDeposit.includes(txn.hash)) continue;
    if(txn.contractType === 1 && trxAddrList.includes(txn.toAddress)) {
      coin = "TRX";
      amount = tronUtil.getActualAmount(txn.amount);
      txn.from = txn.ownerAddress;
      txn.blockNumber = txn.block;
      txn.timeStamp = txn.timestamp/1000;
    } else if (txn.toAddress === process.env.TRX_CONTRACT_ADDRESS) {
      // Oct 15 2020 (danie) - changed checking of events
      const event = await tronUtil.getEventByTxnId(txn);
      const filtered = event.filter(t=>trcAddrList.includes(t.toAddress));
      for(const f of filtered) {
        txn = {...txn, ...f};
        amount = f.amount;
        coin = "TRC20";
        logger.debug("creating deposit : " + txn.hash);
        insertPendingTxn(db, txn, { amount, coin, to: txn.toAddress});
      }
    }
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
