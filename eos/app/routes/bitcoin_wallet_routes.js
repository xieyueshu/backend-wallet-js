const logger = require("../../config/winston");

var bitcoin = require('bitcoinjs-lib');

module.exports = function(app, db) {
	app.post('/testBTCTransaction', (req, res) => {
		let testnet = bitcoin.networks.testnet;
		let wallet = bitcoin.ECPair.makeRandom({network: testnet});
		let addr = wallet.getAddress();
		let pk = wallet.toWIF();
		logger.info(addr + ", " + pk);
		
	    let txb = new bitcoin.TransactionBuilder(testnet);

	    let txid = "c24d5a701c1b382142b4598417cb3915825ff605c6dccc56409f4e5abfa65035";
	    let outn = 0;
	    
	    txb.addInput(txid, outn);
	    
	    txb.addOutput('2Mu4xpJ43A8MKPCtAeRyeALGqW9qtxMezUV', 25000000);

	    let WIF = "cQEiSKWEb6YKAGq4wvktUTfsNqvZpnvNYmdZAcqk651QZYYdVsfr";
	    let keypairSpend = bitcoin.ECPair.fromWIF(WIF, testnet);
	    txb.sign(0, keypairSpend);
	    
	    let tx = txb.build();
	    let texhex = tx.toHex();
		res.send(texhex);
	}); 
}