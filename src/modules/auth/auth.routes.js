const router = require('express').Router();
const c = require('./auth.controller');
const { auth } = require('../../middleware/auth');
router.post('/register', c.register); router.post('/login', c.login); router.post('/refresh', c.refresh); router.post('/logout', auth, c.logout); router.get('/me', auth, c.me);
router.post('/admin-login', c.adminLogin); router.post('/admin-logout', c.adminLogout);
router.post('/forgot-password', c.forgotPassword);
router.post('/reset-password', c.resetPassword);
module.exports = router;
