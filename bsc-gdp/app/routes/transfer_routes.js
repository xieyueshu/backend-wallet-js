const cp = require("child_process");
const BigNumber = require("bignumber.js");
const Web3 = require("web3");

const base = require("../utils/base_utils");
const securityUtil = require("../utils/security_utils");
const dbUtil = require("../utils/db_utils");
const amtUtil = require("../utils/amt_utils");
const ethUtil = require("../utils/eth_utils");
const {passwordMiddleware, isLoggedIn, hasPermissionAction} = require("../utils/route_utils");
const logger = require("../../config/winston");

var child;

module.exports = function(app, db) {
  /**
	 * for testing - encrypt data with the secret key
	 */
  app.post("/encrypt", (req, res) => {
    if(process.env.NODE_ENV !== "development") return res.status(503).send();
    let data = req.body.secret;
    console.log(`encrypting: ${data}`);
    res.send(securityUtil.encryptSecret(data));
  });

  app.post("/encrypt_for_send", (req, res) => {
    if(process.env.NODE_ENV !== "development") return res.status(503).send();
    let data = req.body.secret + "|" + new Date().getTime();
    console.log(`encrypting: ${data}`);
    res.send(securityUtil.encryptSecret(data));
  });

  app.post("/decrypt", (req, res) => {
    if(process.env.NODE_ENV !== "development") return res.status(503).send();
    let data = req.body.secret;
    console.log(`encrypting: ${data}`);
    res.send(securityUtil.decryptSecret(data));
  });

  /**
	 * Send any amount from any address, passing the private key of the address (encrypted using aes)
	 */
  app.post("/sendFrom", async(req, res) => {
    const body = req.body;
    logger.info(`/sendFrom - Received data for sendfrom: ${JSON.stringify(body)}`);
    const required = ["from", "to", "secret", "type", "amount"];
    for(const r of required) {
      if (!body[r]) return res.send({ error: r + "_NOT_FOUND" });
    }
    const maxTime = parseInt(process.env.SEND_FROM_TIME_LIMIT || 2) * 60000; // convert minutes to millis
    // the decrypted data should be <secret key>|<time in milliseconds>
    let decrypted = null;
    try {
      decrypted = securityUtil.decryptSecret(body.secret.trim()).split("|");
    } catch (e) {
      logger.warn(`/sendFrom bad secret : ${e.stack}`);
      return res.send({ error: "BAD_SECRET" });
    }
    let secretKey = decrypted[0];
    const time = parseInt(decrypted[1]);
    if (!secretKey) {
      const dbWallet = await db.collection("address").findOne({ address: body.from.trim() });
      if(!dbWallet) {
        return res.send({error: "ADDRESS_NOT_IN_DB"});
      }
      logger.debug("/sendFrom - getting address from database...");
      secretKey = securityUtil.decryptKey(dbWallet.private);
    }
    logger.debug(`/sendFrom - Time for secret; ${new Date(time)}`);
    if(!time || (new Date().getTime() - time) > maxTime) {
      logger.warn("/sendFrom - secret has expired");
      return res.send({error: "EXPIRED_SECRET"});
    }
    if(body.trace && await dbUtil.hasSameTrace(db, body.trace)) {
      return res.send({error: "DUPLICATE_TRACE"});
    }
    const wallet = {
      fromAddress: body.from.trim(),
      toAddress: body.to.trim(),
      key: secretKey,
      notes: body.notes,
      type: body.type,
      trace: body.trace,
      amount: BigNumber(body.amount).toString(),
      use: "S",
    };
    const type = body.type.toUpperCase();
    const chainList = process.env.CHAIN_SUPPORT;
    let txn = null;
    const isAmtAsset = amtUtil.isAmtAsset(type);
    try {
      if ((isAmtAsset || type === "AMT") && chainList.includes("AMT")) {
        if(isAmtAsset) {
          const amtAsset = base.getValueMem("asset");
          wallet.type = "AMT_A";
          wallet.asset = amtAsset.assetref;
        }
        // we can assume that this is only one transaction so we can get the first entry only
        txn = (await amtUtil.sendAmt(db, wallet))[0]; 
      } else {
        return res.send({error: "type not supported"});
      }
    } catch (err) {
      logger.error(`/sendFrom - Error sending : ${err.stack}`);
      let details = err.error;
      const isJsonErr = securityUtil.toJSON(err.error);
      if(isJsonErr) {
        details = JSON.parse(err.error).error.message || details;
      }
      return res.status(503).send({error: "SENDING_ERROR", details});
    }
    return res.send({status: "OK", data: {
      txnHash: txn.txnHash,
      amount: txn.amount,
      notes: body.notes,
      sender: txn.sender,
      recepient: txn.recepient
    }});
  });

  /**
	 * Trigger collection of deposit wallets
	 */
  app.post("/triggerDeposit", [isLoggedIn, hasPermissionAction, passwordMiddleware], async (req, res) => {
    logger.info("/triggerDeposit - Deposit to cold wallet has been triggered");

    let isMatch = await securityUtil.passwordMatch(db, "coldPass", req.body.password);
    if(!isMatch){
      logger.warn("/triggerDeposit - password doesn't match");
      return res.send({error: "Wrong Password"});
    }
    if(process.env.MANUAL_DEPOSIT !== "Y"){
      return res.send({error: "This function has not been enabled."});
    }

    if(child){
      logger.warn("/triggerDeposit - unable to proceed due to ongoing process");
      return res.send({error: "Another function is currently running."});
    }
    child = cp.fork(
      "app/processes/collection_process.js",
      [global.APP_HASH], {env: process.env});
      
    child.on("message", function(data) {
      logger.debug("/triggerDeposit - Received data from collection_processes: " + data);
      if(data === "DONE"){
        logger.info("/triggerDeposit - Killing child collection_processes");
        child.kill();
        child = null;
      }
    });
    return res.send({status: 1, msg: "Deposit to cold wallet triggered"});
  });

  /**
	 * Trigger transfer of transaction
	 */
  app.post("/transfer/hash", async (req, res) => {
    const { type, hash } = req.body;
    if(!type) return res.send({error:"Type required"});
    if(!hash) return res.send({error:"Hash required"});

    logger.info(`/transfer/hash - transfer ${type} from ${hash}`);

    if(type !== "ETH") return res.send({error:"ETH only supported"});

    const web3 = new Web3(ethUtil.WEB3_PROVIDER);
    try {
      const { value, from, to } = await ethUtil.getTransaction(web3, hash);
      const transferAmount = web3.fromWei(value.toString(), "ether");
      const dbAddress = await dbUtil.retrieveAddress(db, to, "AMTC");
      if(!dbAddress) return res.send({error:"Address not in db"});
      if(value.equals(0)) return res.send({error:"Amount is zero"});

      const transferTxn = await ethUtil.send(db, {
        type, use: "T", gasFromAmount: true,
        amount: transferAmount.toString(),
        toAddress: from,
        fromAddress: dbAddress.address,
        key: dbAddress.private,
      });
      return res.send({status: 1, msg: "Transfer out created: " + transferTxn.txnHash});
    } catch (e) {
      logger.error("Error sending out transfer: " + e.stack);
      return res.send({error:"Error transferring out " + type + ": " + e.message});
    }

  });
};