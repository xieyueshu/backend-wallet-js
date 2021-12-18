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
    logger.info(`${type} ${process.env.ETH_OTHER_CHAIN_NAME} address generated: ${address.address}`);

    const success = await createHelper.insertIntoDb(address, db, res);
    if(!success) return;  
    createHelper.sendAddressAndBackUpToFile(address);
    
    createHelper.encryptSecretForResponse(address, keyPair.privateKey, false);
    address.type = address.type === "AMTC" ? process.env.HRC_CONTRACT_SYMBOL : type;
    return createHelper.sendReponse(address, res);
  },
  modifySendData: async (web3Eth, details, wallet) => {
    if(process.env.ETH_OTHER_CHAIN_NAME === "HECO") {
      details.from = wallet.fromAddress;
      delete details.gas;
      if(details.data === "0x0") delete details.data;
      details.gas = await web3Eth.estimateGas(details);
    }
  }

};