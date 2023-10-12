const fs = require('fs');
const lodash = require('lodash');
const { Server } = require('http');
const Express = require('express');
const Session = require('express-session'); // https://github.com/expressjs/session
const Redis = require('redis'); // https://github.com/NodeRedis/node_redis
const RedisSessionStore = require('connect-redis').default; // https://github.com/tj/connect-redis
const SocketIO = require('socket.io'); // https://github.com/socketio/socket.io/blob/master/docs/README.md
const SocketIORedisAdapter = require('@socket.io/redis-adapter'); // https://socket.io/docs/v4/redis-adapter/
const morgan = require('morgan');
const CookieParser = require('cookie-parser');
const Handlebars = require('handlebars');
const assert = require('assert');
const crypto = require('crypto');
assert([2,3].includes(process.argv.length));
const PORT = process.argv[2] || 3000;
// const REDIS_URL = 'redis://redis:6379';
const REDIS_URL = 'redis://localhost:6379';
const SESSION_COOKIE_NAME = 'connect.sid';
const SESSION_SECRET = 'secrets';
const app = Express();
const server = Server(app);


(async() => {
  const redisClient = Redis.createClient({
    url: 'redis://localhost:6379',
    legacyMode: false,
  });
  redisClient.on('error', err => console.log('Redis Client Error', err));
  await redisClient.connect();
  await redisClient.configSet('notify-keyspace-events', 'EKx');
  console.log('connected to redis');
  // Create one subscriber clinet use for all subscribing needs - socket.io adapter and our own key expire event listener.
  // "When a client issues a [P]SUBSCRIBE that connection is put into a "subscriber" mode. At that point, the only valid commands are those that modify the subscription set, and quit (also ping on some redis versions)."
  const redisSubscriberClient = redisClient.duplicate(); // For express-session events.
  await redisSubscriberClient.connect();
  await redisSubscriberClient.configSet('notify-keyspace-events', 'EKx');

  const sessionStore = new RedisSessionStore({ client: redisClient });
  const templates = {
    login: Handlebars.compile(fs.readFileSync(__dirname + '/login.html').toString()),
  };
  let messageBuffer = [];

  server.listen(PORT, () => {
    console.log(`listening on *:${PORT}`);
  });
  app.use(morgan('common', { stream: { write: message => { console.info(message.trim(), { tags: 'http' }); } } }));
  app.use(Session({
    store: sessionStore,
    secret: SESSION_SECRET,
    name: SESSION_COOKIE_NAME,
    resave: true,
    rolling: true, // Reset max age with each new client request.
    saveUninitialized: true,
    cookie: { maxAge: 15000 }},
  ));
  // app.use(CookieParser(SESSION_SECRET));
  app.use(Express.urlencoded({ limit: '1MB', extended: true }));
  app.use(Express.json({ type: '*/*', limit: '1MB' }));

  /**
   * Logged in users service. Thin wrapper over session store to enumerate logged in user sessions.
   */
  async function getUsers() {
    let sessions = (await new Promise((resolve, reject) => {
      sessionStore.all((err, sessions) => {
        if (err) reject(err);
        else resolve(sessions);
      });
    }))
      .filter((v) => v.auth === 1)
      .map((v) => lodash.pick(v, ['nick', 'color', 'socket_id']));
    if (sessions.length)  {
      let statuses = await redisClient.mGet(sessions.map(u => `users:${u.nick}:status`));
      sessions = sessions.map((s, i) => ({ ...s, status: statuses[i] }));
    }
    sessions = lodash.keyBy(sessions, 'nick');
    return sessions;
  }

  app.get('/login', (req, res) => {
    if (req.session.auth == 1) {
      res.redirect(303, '/');
    }
    else {
      res.send(templates.login({}));
    }
  });

  app.post('/login', async (req, res, next) => {
    try {
      const regexp = /^\w[\w_-]{3,11}$/;
      const errors = [];

      if (!regexp.test(req.body.nick)) {
        errors.push({ message: `Nick must match '${regexp}'` });
      }
      const nicks = Object.keys((await getUsers()));
      if (!errors.length && nicks.indexOf(req.body.nick) >= 0) {
        errors.push({message: `Nick '${req.body.nick}' is already being used`});
      }
      if (!errors.length) {
        login(req, io);
        res.redirect(303, '/');
      }
      else {
        res.send(templates.login({ errors: errors }));
      }
    }
    catch (err) {
      next(err);
    }
  });

  app.get('/logout', (req, res, next) => {
    console.log(`logout requested for ${req.session}`);
    logout(req);
    res.redirect(303, '/login');
  });

  app.use(Express.static('app'));

  // app.get('*', function (req, res) {
  //   console.log(req.query, typeof(req.query));
  //   res.json({
  //     req: {
  //       method: req.method,
  //       path: req.path,
  //       query: req.query,
  //       headers: req.headers,
  //     },
  //     res: {
  //       headers: res.headers,
  //     },
  //   });
  // });

  /**
   * Guarded end points.
   */
  app.use((req, res, next) => {
    if (req.session.auth === 1) {
      next('route');
    }
    else {
      res.redirect(303, '/login');
    }
  });

  app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
  });

  app.get('/users', async (req, res) => {
    res.send(await getUsers());
  });

  app.get('/ping', async (req, res) => {
    res.send('pong');
  });

  /**
   * Purge user login data.
   */
  async function logout(req) {
    if (!req.session) return;
    req.session.destroy();
    io.emit('update', { users: (await getUsers()) } );
  }

  /**
   * Do whats needed to log the user in.
   */
  async function login(req, io) {
    req.session.auth = 1;
    req.session.nick = req.body.nick;
    req.session.color = '#' + Math.random().toString().substring(2,8).toUpperCase();
    io.emit('update', { users: (await getUsers()) } );
    console.log(`Subscribing to __keyspace@0__:sess:${req.session.id}`);
  }

  /**************************************************************************************************
   * BEGIN SOCKET SERVER
   *
   * Setup the socket server which runs completely independently of Express app and controls the
   * \/socket.io path.
   *
   * Sessions: We can access the Express session in a socket but the session middleware isn't invoked
   * the same as in Express, and it's dodgy. So using custom session access based off express-session
   * cookie (ignoring signature). See setSessionObject().
   **************************************************************************************************/

  const redisAdaptor = SocketIORedisAdapter.createAdapter(redisClient, redisSubscriberClient);
  const io = SocketIO(server, {
    pingInterval: 10000,
    pingTimeout: 5000,
    adapter: redisAdaptor,
  });
  const cookieParser = CookieParser(SESSION_SECRET);
  io.use((socket, next) => cookieParser(socket.request, {}, next));

  io.use(initializeSocketSession);
  io.use(authenticateConnection);

  io.engine.generateId = (req) => {
    cookieParser(req, null, () => {});
    return crypto.randomBytes(16).toString('hex');
  };

  io.on('connection', (socket) => {
    console.log(`new socket connection: id=${socket.id}`);
    socket.use((packet, next) => setSessionObject(socket, next));
    socket.use((packet, next) => touchOnline(socket, next));
    socket.on('chat message', (message) => chatMessage(socket, message));
    socket.on('direct message', (message) => directMessage(socket, message));
    socket.on('disconnect', (data, next) => { console.log('socket disconnected'); });
    initConnectedSocket(socket);
    touchOnline(socket, () => {});
  });

  /**
   * Listener for expired session events. Could be used to clean up non session
   * storage user data and log the user out on session expiration.
   */
  await redisSubscriberClient.pSubscribe(`__keyspace@0__:sess:*`, (message, channel) => {
    console.log(message, channel);
    if (message === 'expired') {
      console.log(`session expired: ${channel.split(':')[2]}`);
    }
  });

  async function initializeSocketSession(socket, next) {
    try {
      const sessionId = socket.request.signedCookies[SESSION_COOKIE_NAME];
      console.log(`initializeSocketSession() found sid=${sessionId}`);
      const session = await new Promise((resolve, reject) => {
        sessionStore.get(sessionId, (err, session) => {
          if (err) reject(err);
          resolve(session);
        });
      });
      session.socket_id = socket.id;
      socket.data.sessionId = sessionId; // See setSessionObject()
      socket.conn.session = session;
      saveSession(socket);
      next();
    }
    catch (err) {
      console.error('No existing session was found for this connection. Please signin.');
      socket.disconnect(true);
      next(err);
    }
  }


  /**
   * Session based authentication of the connection on connection establishment. Auth is not checked with
   * each socket event.
   */
  function authenticateConnection(socket, next) {
    if (!socket.conn.session || !(socket.conn.session.auth == 1)) {
      console.error('user not logged in');
      socket.disconnect(true);
      next(new Error('You are not logged in')); // This doesn't actually disconnect. Just sends 'error' back.
    }
    else {
      console.log(`${socket.conn.session.nick} is logged in`);
      next();
    }
  }


  /**
   * On new connection, send buffer of latest messages, users, and the users nick for the duration of the login.
   */
  async function initConnectedSocket(socket) {
    const users = await getUsers();
    socket.emit('init', { nick: socket.conn.session.nick, users });
    for (let message of messageBuffer) {
      socket.emit('chat message', message);
    }
  }


  /**
   */
  async function touchOnline(socket, next) {
    try {
      const session = socket.conn.session;
      const k = `users:${session.nick}:status`;
      const status = await redisClient.get(k);
      await redisClient.set(k, 'online', 'EX', '15');
      if (!status) {
        io.emit('update', { users: (await getUsers()) } );
      }
      console.log('touchOnline', k);
      next();
    }
    catch (err) {
      console.error(err);
      socket.disconnect(true);
      next(err);
    }
  }


  /**
   * Used to refresh the request.session object manually with every packet. The session object
   * attached to request goes stale since the express-session MW is only invoked on new connections not new packets.
   * Invoking it with each packet does not work either. This is the only robust solution I've found.
   * Precondition: initializeSocketSession.
   */
  async function setSessionObject(socket, next) {
    try {
      const sessionId = socket.data.sessionId;
      const session = await new Promise((resolve, reject) => {
        sessionStore.get(sessionId, (err, session) => {
          if (err || !session) reject(new Error('Undefined session'));
          resolve(session);
        });
      });
      socket.conn.session = session;
      console.log('setSessionObject', session);
      next();
    }
    catch (err) {
      console.error('No session found for connection. Please sign in again.');
      socket.disconnect(true);
      next(err);
    }
  }


  /**
   * Sync socket.conn.session with session store. This isn't MW because AFAIK middleware runs always
   * runs first, so you have to call it explicitly.
   * BUG: If the session cookie isn't being updated this can cause: "Error: ReplyError: ERR invalid expire time in set"
   *  This only happens when the session is close to being expired. Currently fails silently and
   *  shortly after the session should expire.
   */
  function saveSession(socket) {
    const { sessionId, session } = socket.conn;
    if (sessionId && session) {
      sessionStore.set(sessionId, socket.conn.session, (err) => {
        if (err) return console.error(`Failed to save session: ${err}`);
        console.log('saveSession');
      });
    }
  }


  function chatMessage(socket, data) {
    let session = socket.conn.session;
    try {
      session.chat_count = session.chat_count ? session.chat_count + 1 : 1;
      saveSession(socket);
      if (data.length == 0) {
        io.emit('error', Error('Message has length of 0'));
      }
      else if (data.length > 1000) {
        io.emit('error', Error(`Message too big [${data.length}]`));
      }
      else {
        let payload = {
          text: data,
          timestamp: new Date().getTime(),
          user: session.nick,
        };
        messageBuffer.push(payload);
        messageBuffer = messageBuffer.slice(-3, messageBuffer.length);
        io.emit('chat message', payload); // Emit to every connected socket
        console.log(`chat message: @${session.nick}: ${data}`);
      }
    } catch (err) {
      socket.emit('user error', { error: 'Could not send message' });
    }
  }


  async function directMessage(socket, data) {
    let session = socket.conn.session;
    let {nick, message} = data;
    try {
      session.dm_count = session.dm_count ? session.dm_count + 1 : 1;
      saveSession(socket);
      let user = (await getUsers())[nick];
      if (!user) {
        throw new Error('User does not exist');
      }
      let payload = {
        text: message,
        timestamp: new Date().getTime(),
        user: session.nick,
        to: nick,
      };
      console.log(`direct message: @${session.nick}:`, data, user.socket_id);
      socket.emit('chat message', payload);
      socket.to(user.socket_id).emit('chat message', payload);
    }
    catch (err) {
      socket.emit('user error', { error: `Could not send direct message to ${nick}` });
    }
  }
})();
// .then(() => { console.log('Done'); process.exit(); })
// .catch((err) => {
//   console.error(err, { stack: err.stack });
//   process.exit(1);
// });