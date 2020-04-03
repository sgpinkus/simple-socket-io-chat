const fs = require('fs');
const Express = require('express');
const Session = require('express-session'); // https://github.com/expressjs/session
const ConnectRedis = require('connect-redis')(Session); // https://github.com/tj/connect-redis
const { Server } = require('http');
const SocketIO = require('socket.io'); // https://github.com/socketio/socket.io/blob/master/docs/README.md
const morgan = require('morgan');
const BodyParser = require('body-parser');
const CookieParser = require('cookie-parser')
const Redis = require('redis'); // https://github.com/NodeRedis/node_redis
const RedisAdapter = require('socket.io-redis');
require('bluebird').promisifyAll(Redis); // Monkey patches xxxAsync() for all xxx() -- https://github.com/NodeRedis/node_redis
const Handlebars = require('handlebars');
const assert = require('assert');
const crypto = require('crypto');

assert([2,3].includes(process.argv.length));
const port = process.argv[2] || 3000;
const app = Express();
const server = Server(app);
const REDIS_PORT = 6380
const SESSION_COOKIE_NAME = 'connect.sid';
const SESSION_SECRET = 'secrets';
const redisClient = Redis.createClient(REDIS_PORT);
const redisSub = Redis.createClient(REDIS_PORT);
const sessionStore = new ConnectRedis({ client: redisClient });
const session = Session({
  store: sessionStore,
  secret: SESSION_SECRET,
  name: SESSION_COOKIE_NAME,
  resave: true,
  rolling: true, // Reset max age with each new client request.
  saveUninitialized: true,
  cookie: { maxAge: 15000 }}
);
const templates = {
  login: Handlebars.compile(fs.readFileSync(__dirname + '/login.html').toString()),
}
let messageBuffer = [];

/**
 * Inefficient way of establishing list of logged in users by enumerating sessions.
 */
const users = new class {
  constructor(sessionStore) {
    this.sessionStore = sessionStore
  }

  async getUsers() {
    let sessions = (await new Promise((resolve, reject) => {
        this.sessionStore.all((err, sessions) => {
          if(err) reject(err);
          else resolve(sessions);
        });
    })).filter((v) => v.auth == 1).map((v) => { return { nick: v.nick, color: v.color, socket_id: v.socket_id } });
    return sessions
  }

  async getNicks() {
    return (await this.getUsers()).map((v) => v.nick)
  }

  async getUserByNick(nick) {
    return (await this.getUsers()).filter((v) => v.nick == nick)[0]
  }
}(sessionStore)


/**
 * This currently does nothing but log a msg. Could be used to clean up non session storage user data
 * and log the user out on session expiration.
 */
redisSub.on('message', (channel, message) => {
  switch(message) {
    case 'expired':
      console.log(`session expired: ${channel.split(':')[2]}`);
      break;
    default:
      break;
  }
});

server.listen(port, () => {
  console.log(`listening on *:${port}`);
});

app.use(morgan('common', { stream: { write: message => { console.info(message.trim(), { tags: 'http' }); } } }));
app.use(session)
app.use(BodyParser.json()); // support json encoded bodies
app.use(BodyParser.urlencoded({ extended: true })); // support encoded bodies

app.get('/login', (req, res) => {
  if(req.session.auth == 1) {
    res.redirect(303, '/')
  }
  else {
    res.send(templates.login({}));
  }
});

app.post('/login', async (req, res, next) => {
  try {
    const regexp = /^\w[\w_-]{3,11}$/
    const errors = []

    if(!regexp.test(req.body.nick)) {
      errors.push({ message: `Nick must match '${regexp}'` })
    }
    if(!errors.length && (await users.getNicks()).indexOf(req.body.nick) >= 0) {
      errors.push({message: `Nick '${req.body.nick}' is already being used`})
    }
    if(!errors.length) {
      login(req, io)
      res.redirect(303, '/')
    }
    else {
      res.send(templates.login({ errors: errors }));
    }
  }
  catch (err) {
    next(err)
  }
})

app.get('/logout', (req, res, next) => {
  console.log(`logout requested for ${req.session}`)
  logout(req)
  res.redirect(303, '/login');
});

app.use(Express.static('app'));

/**
 * Guarded end points.
 */
app.use((req, res, next) => {
  if(req.session.auth == 1) {
    next('route')
  }
  else {
    res.redirect(303, '/login');
  }
});


app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

app.get('/users', async (req, res) => {
  res.send(await users.getUsers())
});

app.get('/ping', async (req, res) => {
  res.send('pong')
});


/**
 * Purge user login data.
 */
async function logout(req) {
  if(!req.session) return
  req.session.destroy()
  io.emit('update', { users: (await users.getUsers()) } );
}

/**
 * Do whats needed to log the user in.
 */
async function login(req, io) {
  req.session.auth = 1;
  req.session.nick = req.body.nick;
  req.session.color = '#' + Math.random().toString().substring(2,8).toUpperCase()
  io.emit('update', { users: (await users.getUsers()) } );
  redisSub.subscribe(`__keyspace@0__:sess:${req.session.id}`);
}


/**************************************************************************************************
 * BEGIN SOCKET SERVER
 *
 * Setup the socket server which runs completely independently of Express app and controls the
 * \/socket.io path.
 *
 * Sessions: We can access the Express session in a socket but the session middleware isn't invoked
 * the same as in Express, and it's dodgy. So using custom session access based off express-session
 * cookie (ignoring signature). See setSession().
 **************************************************************************************************/

const redisAdaptor = RedisAdapter({ host: 'localhost', port: 6380 });
const io = SocketIO(server, {
  pingInterval: 10000,
  pingTimeout: 5000,
  adapter: redisAdaptor,
});
const cookieParser = CookieParser(SESSION_SECRET);

io.use((socket, next) => cookieParser(socket.request, {}, next));
io.use(initializeConnectionSession);
io.use(authenticateConnection);
io.use(debugConnection);


let custom_id=0;
io.engine.generateId = (req) => {
  console.debug('Generating new id');
  console.debug(req.headers);
  cookieParser(req, null, () => {});
  console.log(req.cookies);
  return crypto.randomBytes(16).toString('hex');
}


io.on('connection', (socket) => {
  console.log(`new socket connection: id=${socket.id}`);
  socket.use((packet, next) => setSession(socket, next));
  socket.on('chat message', (message) => chatMessage(socket, message));
  socket.on('direct message', (message) => directMessage(socket, message));
  socket.on('disconnect', (data, next) => { console.log('socket disconnected'); });
  initConnectedSocket(socket);
});


async function initializeConnectionSession(socket, next) {
  try {
    const sessionId = socket.request.signedCookies[SESSION_COOKIE_NAME];
    console.log('Found sid', sessionId);
    const session = await new Promise((resolve, reject) => {
      sessionStore.get(sessionId, (err, session) => {
        if(err) reject(err);
        resolve(session);
      });
    });
    console.log('Found session', session);
    session.socket_id = socket.id;
    socket.conn.sessionId = sessionId;
    socket.conn.session = session;
    saveSession(socket);
    next();
  }
  catch(err) {
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
  if(!socket.conn.session || !(socket.conn.session.auth == 1)) {
    console.error('user not logged in');
    socket.disconnect(true);
    next(new Error('You are not logged in')); // This doesn't actually disconnect. Just sends 'error' back.
  }
  else {
    console.log(`${socket.conn.session.nick} is logged in`);
    next();
  }
}


function debugConnection(socket, next) {
  const { signedCookies, cookies } = socket.request;
  console.log('signedCookies', signedCookies)
  console.log('cookies', cookies);
  next();
}


/**
 * Used to refresh the request.session object manually with every packet. The session object
 * attached to request goes stale since the express-session MW is only invoked on new connections not new packets.
 * Invoking it with each packet does not work either. This is the only robust solution I've found.
 * Precondition: initializeConnectionSession.
 */
async function setSession(socket, next) {
  try {
    const sessionId = socket.conn.sessionId;
    const session = await new Promise((resolve, reject) => {
      sessionStore.get(sessionId, (err, session) => {
        if(err) reject(err);
        if(!session) reject(new Error('Undefined session'));
        resolve(session);
      });
    });
    console.log('Setting session', session);
    socket.conn.session = session;
    next();
  }
  catch(err) {
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
  if(sessionId && session) {
    sessionStore.set(sessionId, socket.conn.session, (err) => {
      if(err) return console.error(`Failed to save session: ${err}`);
      console.log('Saved session');
    });
  }
}


async function initConnectedSocket(socket) {
  const user = { nick: socket.conn.session.nick, color: socket.conn.session.color };
  socket.emit('update', { user: user, users: (await users.getUsers()) });
  for(let message of messageBuffer) {
    socket.emit('chat message', message);
  }
}


function chatMessage(socket, data) {
  let session = socket.conn.session;
  console.log(`chat message: @${session.nick}: ${data}`);
  try {
    session.chat_count = session.chat_count ? session.chat_count + 1 : 1;
    saveSession(socket);
    if(data.length == 0) {
      io.emit('error', Error('Message has length of 0'));
    }
    else if(data.length > 1000) {
      io.emit('error', Error(`Message too big [${data.length}]`));
    }
    else {
      let payload = {
        message: data,
        timestamp: new Date().getTime(),
        user: { nick: session.nick, color: session.color },
      }
      messageBuffer.push(payload);
      messageBuffer = messageBuffer.slice(-3, messageBuffer.length);
      io.emit('chat message', payload); // Emit to every connected socket
    }
  } catch(err) {
    socket.emit('user error', { error: `Could not send message` });
  }
}


async function directMessage(socket, data) {
  let session = socket.conn.session;
  let {nick, message} = data;
  try {
    session.dm_count = session.dm_count ? session.dm_count + 1 : 1;
    saveSession(socket);
    let user = (await users.getUserByNick(nick))
    if(!user) {
      throw new Error('User does not exist')
    }
    let payload = {
      message: message,
      timestamp: new Date().getTime(),
      user: { nick: session.nick, color: session.color },
      to: user,
    }
    console.log(`direct message: @${session.nick}:`, data, user.socket_id);
    socket.emit('chat message', payload);
    socket.to(user.socket_id).emit('chat message', payload);
  }
  catch(err) {
    socket.emit('user error', { error: `Could not send direct message to ${nick}` });
  }
}
