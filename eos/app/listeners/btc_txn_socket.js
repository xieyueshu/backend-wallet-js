const socket = require("socket.io-client")(process.env.BTC_SOCKET);
const sb = require("satoshi-bitcoin");
const cp = require("child_process");

const logger = require("../../config/winston");
const btcUtil = require("../utils/btc_utils");
const btcDb = require("../utils/btc_lib/btc_db_utils");
const dbUtil = require("../utils/db_utils");


module.exports = {
  start: (db) => {
    // get all transactions that have been mined but not listened
    // for yet
    let child = cp.fork(
      'app/processes/btc_deposit_process.js',
      [], {
        env: process.env
      });
    child.on('message', function (data) {
      logger.debug("btc_txn_socket - Received data from btc_deposit_process: " + data);
      if (data === "DONE") {
        logger.info("btc_txn_socket - Killing btc_deposit_process");
        child.kill();
        child = null;
      }
    });


    // listen for new unconfirmed transactions
    socket.on("tx", async function (txn) {
      const addrList = await dbUtil.getDepositAddr(db, "BTC");
      for (let c = 0; c < txn.vout.length; c++) {
        for (toAddr in txn.vout[c]) {
          if (addrList.includes(toAddr)) {
            await btcDb.insertPendingTxn(db, {
              to: toAddr,
              amount: sb.toBitcoin(txn.vout[c][toAddr]),
              txid: txn.txid,
            });
          }
        }
      }
    });

    socket.on("block", async function (blkHash) {
      const block = await btcUtil.getBlock(blkHash);
      logger.info("btc_txn_socket - updating last block to " + block.height);
      await db.collection("base").update({
        name: "lastBlkBtc"
      }, {
        $set: {
          value: block.height
        }
      }, {
        upsert: true
      });
    });

    socket.emit('subscribe', 'inv');

  }
}