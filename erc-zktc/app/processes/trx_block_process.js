// Oct 7 2020 (danie) - added separate process for deposit
require("dotenv").config();

const MongoClient = require("mongodb").MongoClient;
const db = require("../../config/db");

const dbUtil = require("../utils/db_utils");
const tronUtil = require("../utils/tron_utils");
const logger = require("../../config/winston");

MongoClient.connect(db.url, async (err, database) => {
  if (err) {
    logger.error("Unable to connect to database - " + err.stack);
    return;
  }
  let status = "DONE";

  const walletDb = database.db(db.name);
  let lastBlk;
  try {
    lastBlk = await retrieveLatestBlock(walletDb);
  } catch (e) {
    status = "ERROR";
    logger.error("error retrieving trx block: " + e.stack);
  }
  await database.close();
  if(process.send) {
    process.send(JSON.stringify({status, lastBlk}));
  } else {
    process.exit(0);
  }
});

async function retrieveLatestBlock(db) {
  let fromBlk = (await dbUtil.getBaseItemValue(db, "lastBlkTrx"));
  let toBlk = await tronUtil.getLastBlockNum();
  if (fromBlk > toBlk) fromBlk = toBlk;
  logger.debug("last block from db: "+ fromBlk + " from util: "+ toBlk);

  for (let blk = fromBlk; blk < toBlk; blk++) {
    await db.collection("trx_block").updateOne({ block: blk }, { $set: { block: blk, status: "PENDING" } }, { upsert: true });
  }
  logger.debug("deposit_checker_job - last block: " + toBlk);
  await db.collection("base").findOneAndUpdate({ name: "lastBlkTrx" }, { $set: { value: toBlk } });
  return toBlk;
}

