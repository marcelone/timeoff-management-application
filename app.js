'use strict';
require('./lib/promise-shim');
require('./lib/validator-shim');

var express      = require('express');
var path         = require('path');
var favicon      = require('serve-favicon');
var logger       = require('morgan');
var cookieParser = require('cookie-parser');
var bodyParser   = require('body-parser');
var moment       = require('moment');
const createSessionMiddleware = require('./lib/middleware/withSession');
const helmet = require('helmet');
const { createAuthRateLimit } = require('./lib/middleware/auth-rate-limit');
const csrfProtection = require('./lib/middleware/csrf');

var app = express();

if (String(process.env.TRUST_PROXY) === 'true') app.set('trust proxy', 1);

// Per-request CSP nonce for the (optional) inline analytics script.
app.use((req, res, next) => {
  res.locals.cspNonce = require('crypto').randomBytes(16).toString('base64');
  next();
});
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", (req, res) => `'nonce-${res.locals.cspNonce}'`, "https://www.google-analytics.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      imgSrc: ["'self'", "data:", "https://www.google-analytics.com"],
      connectSrc: ["'self'", "https://www.google-analytics.com"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
    },
  },
}));

// View engine setup.
// Handlebars proto-access is tightened: only methods defined on our Sequelize
// models may be invoked from templates (allowProtoMethodsByDefault:false + an
// explicit whitelist built from the model prototypes). Attribute getters remain
// accessible as data (allowProtoPropertiesByDefault:true); Handlebars still blocks
// dangerous members (constructor/__proto__/__defineGetter__...) by default.
const dbModels = require('./lib/model/db');
const allowedProtoMethods = {};
for (const modelName of Object.keys(dbModels)) {
  const M = dbModels[modelName];
  if (M && M.prototype) {
    for (const k of Object.getOwnPropertyNames(M.prototype)) {
      if (k === 'constructor') continue;
      // Use the descriptor: reading M.prototype[k] would invoke Sequelize
      // attribute getters on the prototype (no dataValues) and throw.
      const desc = Object.getOwnPropertyDescriptor(M.prototype, k);
      if (desc && typeof desc.value === 'function') allowedProtoMethods[k] = true;
    }
  }
}
var handlebars = require('express-handlebars')
  .create({
    defaultLayout : 'main',
    extname       : '.hbs',
    helpers       : require('./lib/view/helpers')(),
    runtimeOptions : { allowProtoPropertiesByDefault: true, allowProtoMethodsByDefault: false, allowedProtoMethods },
  });

app.engine('.hbs', handlebars.engine);
app.set('view engine', '.hbs');

// Add single reference to the model into application object
// and reuse it whenever an access to DB is needed
app.set('db_model', require('./lib/model/db'));

// uncomment after placing your favicon in /public
//app.use(favicon(__dirname + '/public/favicon.ico'));
// Redact sensitive query params (CSRF / reset tokens) from access logs.
logger.token('safe-url', (req) => String(req.originalUrl || req.url || '').replace(/([?&])(_csrf|t)=[^&]*/g, '$1$2=REDACTED'));
app.use(logger(process.env.NODE_ENV === 'production'
  ? ':remote-addr - :remote-user [:date[clf]] ":method :safe-url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent"'
  : ':method :safe-url :status :response-time ms - :res[content-length]'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Liveness/readiness probe (public, used by Docker/Coolify healthcheck).
app.get('/healthz', async (req, res) => {
  try {
    await app.get('db_model').sequelize.authenticate();
    res.json({ status: 'ok' });
  } catch (e) {
    res.status(503).json({ status: 'error' });
  }
});



// Setup authentication mechanism
const passport = require('./lib/passport')();

app.use(createSessionMiddleware({
  sequelizeDb: app.get('db_model').sequelize,
}))
app.use(passport.initialize());
app.use(passport.session());

// CSRF protection (session synchronizer token) for cookie-authenticated requests.
app.use(csrfProtection);

// Rate-limit authentication endpoints.
app.use(createAuthRateLimit());



// Custom middlewares
//
// Make sure session and user objects are available in templates
app.use(function(req,res,next){

  // Get today given user's timezone
  var today;

  if ( req.user && req.user.company ) {
    today = req.user.company.get_today();
  } else {
    today = moment.utc();
  }

  res.locals.session     = req.session;
  res.locals.logged_user = req.user;
  res.locals.url_to_the_site_root = '/';
  res.locals.requested_path = req.originalUrl;
  // For book leave request modal
  res.locals.booking_start = today,
  res.locals.booking_end = today,
  res.locals.keep_team_view_hidden =
    !! (req.user && req.user.company.is_team_view_hidden && ! req.user.admin);

  next();
});

app.use(function(req,res,next){
    res.locals.custom_java_script = [
      '/js/bootstrap-datepicker.js',
      '/js/global.js'
    ];
    res.locals.custom_css = [
      '/css/bootstrap-datepicker3.standalone.css'
    ];

    next();
});

// Enable flash messages within session
app.use( require('./lib/middleware/flash_messages') );

app.use( require('./lib/middleware/session_aware_redirect') );

// Here will be publicly accessible routes

app.use(
  '/feed/',
  require('./lib/route/feed')
);

app.use(
  '/integration/v1/',
  require('./lib/route/integration_api')(passport)
);

app.use(
  '/',
  require('./lib/route/login')(passport),

  // All rotes bellow are only for authenticated users
  require('./lib/route/dashboard')
);

app.use('/api/v1/workcenters', require('./lib/route/workcenters'));
app.use('/api/v1/', require('./lib/route/api'));

app.use(
  '/calendar/',
  require('./lib/route/calendar')
);

app.use(
  '/settings/',
  require('./lib/route/settings')
);

// '/settings/' path is quite big hence there are two modules providing handlers for it
app.use('/settings/', require('./lib/route/departments'));
app.use('/settings/', require('./lib/route/work_centers'));
app.use('/settings/', require('./lib/route/break_policy'));
app.use('/settings/', require('./lib/route/bankHolidays'));

// Time tracking (block 1): own sessions + expected schedules.
app.use('/time', require('./lib/route/time'));

app.use(
  '/users/',
  // Order of following requires for /users/ matters
  require('./lib/route/users/summary'),
  require('./lib/route/users')
);

app.use(
  '/requests/',
  require('./lib/route/requests')
);

app.use(
  '/audit/',
  require('./lib/route/audit')
);

app.use(
  '/reports/',
  require('./lib/route/reports')
);

// catch 404
app.use(function(req, res, next) {
  res.render('not_found');
});


// error handlers

// development error handler
// will print stacktrace
if (app.get('env') === 'development') {
    app.use(function(err, req, res, next) {
        res.status(err.status || 500);
        res.render('error', {
            message: err.message,
            error: err
        });
    });
}

// production error handler: generic message to the client, details logged server-side.
app.use(function(err, req, res, next) {
    console.error('Unhandled error:', err && err.stack ? err.stack : err);
    res.status(err.status || 500);
    res.render('error', {
        message: 'An unexpected error occurred. Please try again later.',
        error: {}
    });
});

module.exports = app;
