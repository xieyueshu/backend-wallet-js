const Web3Accounts = require("web3-eth-accounts");

const logger = require("../../config/winston");
const secUtil = require("./security_utils");

const createHelper = require("./chain_lib/create_wallet.helper");


module.exports = {
  createWallet: async (res, db, options) => {
    const { type } = options;
    const accounts = new Web3Accounts(process.env.NODE_ETH_NETWORK);
    const keyPair = accounts.create();
    const walletAddress= keyPair.address.toLowerCase();
    let address = {
      type,
      use: "D",
      address: walletAddress,
      //encrypt the key before storing it in the database
      private: secUtil.encryptKey(keyPair.privateKey),
      public: keyPair.publicKey
    };
    logger.info(type + " HECO address generated: " + address.address);

    const success = await createHelper.insertIntoDb(address, db, res);
    if(!success) return;  
    createHelper.sendAddressAndBackUpToFile(address);
    
    createHelper.encryptSecretForResponse(address, keyPair.privateKey, false);
    address.type = address.type === "AMTC" ? process.env.HRC_CONTRACT_SYMBOL : type;
    return createHelper.sendReponse(address, res);
  },

};