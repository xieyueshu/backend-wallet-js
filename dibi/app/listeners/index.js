const MongoClient = require("mongodb").MongoClient;
const db = require("../../config/db");
const logger = require("../../config/winston");

const btcTxnSocket = require("./btc_txn_socket");

MongoClient.connect(db.url, (err, database) => {
  if (err) {
    logger.error("listener index: Error connecting to database " + err);
    return;
  }

  logger.info("listener process connected to db successfully");
  logger.info("=== Starting up sockets jobs. ===");
  const walletDb = database.db(db.name);
  if (process.env.CHAIN_SUPPORT.includes("BTC")) {
    btcTxnSocket.start(walletDb);
  }
});