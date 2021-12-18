// Oct 7 2020 (danie) - added separate process for deposit
require("dotenv").config();

const MongoClient = require("mongodb").MongoClient;
const db = require("../../config/db");

const dbUtil = require("../utils/db_utils");
const filUtil = require("../utils/fil_utils");
const filecoin = require("../utils/fil_lib/filecoin");
const logger = require("../../config/winston");

global.APP_HASH = process.argv[2];
global.SHARED_KEY = process.argv[3];
if(!process.argv[4] || isNaN(process.argv[4])) {
  logger.warn("No block number provided for fil deposit process.");
  if(process.send) {
    process.send(JSON.stringify({block:null, status:"ERROR"}));
  } else {
    process.exit(0);
  }
}
const blockNum = parseInt(process.argv[4]);

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
    logger.error(`fil_deposit_process - error while retrieving block ${blockNum}: ${e}`);
    status = "ERROR";
  }
  await database.close();
  if(process.send) {
    process.send(JSON.stringify({block:blockNum, status}));
  } else {
    process.exit(0);
  }
});

const processBlock = async (db, blockNum) => {
  let dBDeposit = await dbUtil.getTxnHashList(db, ["FIL"], ["D"]);
  const filAddrList = await dbUtil.getDepositAddr(db, "FIL");	
  const txnList = await filUtil.getTransactionList(blockNum); // process the block passed	  
  for (let i=0,j=txnList.length;i<j;i++){
    let txn=txnList[i];				
    if(dBDeposit.includes(txn.cid)) continue;
    if(filAddrList.includes(txn.to)) {
      logger.debug("found deposit transaction :" + txn.cid + " for " + txn.to);
      //for some reason, the browser returns duplicate transactions in the list
      //so we need to update the in memory list while looping
      txn.block_height=blockNum;
      insertPendingTxn(db,txn);
      dBDeposit.push(txn.cid);
    }
  }	
};

const insertPendingTxn = async (db, txn) => {
  let txnDetails = {	 
    txnType: "D",
    coinType: "FIL",
    sender: txn.from,
    recepient: txn.to,
    amount: Number(filecoin.attoFilToFilString(txn.value)),
    createTime: new Date(),
    gas:0,
    nonce: 0,
    txnHash: txn.cid,
    status: "P",
    checked: true,
    timeStamp: 0,
    blockNumber: txn["block_height"],
    trace: ""
  };
  logger.info("fil_deposit_process - inserting fil deposit with hash: " + txnDetails.txnHash);

  await db.collection("transaction").insert(txnDetails);
  return txnDetails;
};
