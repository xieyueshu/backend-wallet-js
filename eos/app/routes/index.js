const bWalletRoutes = require('./bitcoin_wallet_routes');
const publicRoutes = require('./public_routes');
const rateRoutes = require('./rate_routes');
const settingRoutes = require('./settings_routes');
const transactionRoutes = require('./transaction_routes');
const transferRoutes = require('./transfer_routes');
const walletRoutes = require('./wallet_routes');
const withdrawRoutes = require('./withdraw_routes');
const depositRoutes = require('./deposit_routes');
const userRoutes = require('./user_routes');
const czdtRoutes = require('./czdt_routes');

module.exports = function (app, db) {
	bWalletRoutes(app, db);
	publicRoutes(app, db);
	rateRoutes(app, db);
	settingRoutes(app, db);
	transactionRoutes(app, db);
	transferRoutes(app, db);
	walletRoutes(app, db);
	withdrawRoutes(app, db);
	depositRoutes(app, db);
	userRoutes(app, db);
	czdtRoutes(app, db);

	app.use(function (req, res) {
		return res.status(404).render('error_404');
	});
};