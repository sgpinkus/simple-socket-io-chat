# Overview
This is a simple chat app developed as a personal learning aid following on from the basic chat application in the [socket.io tutorial](https://socket.io/get-started/chat/). Also serves as a simple 101 on [React](https://reactjs.org/) but avoids the React "wall of configuration" / "tool chain" bull shit by loading React and Babel in-browser.

---

<img src="screenshot.png" />

---

# Notes

## Requirements

  - [x] **"Login" sessions and Nicks** Users must "login". Sufficient to stub out a real life "login" by just redirecting to a page where users enter a nick. Confirm the nick is not currently used by an active login session then set the user as "logged in". Store a randomized color for the session and render the nick in each message, and where ever else with the given color. Use express-session and Redis for session storage and for storing the list of currently logged in users.
  - [x] **Message queue Requirements:**
    - Show the last two or three messages when a user logs in.
    - Show the user local date on all messages.
    - Limit the number of messages kept client side to 1000.
    - Limit the size of messages front-end and back-end.
  - [x] **Dynamically update list of users online** Store and show the list of users that are online. When a user is inactive to more then 2 minutes automatically log the user out. The nick is made available again.
  - [x] **Use single page in-browser React component for Front end.**
  - [x] **Use ExpressJS for the backend.**
  - [x] **Add direct 1to1 private directs messaging (DM)** Use the main messaging pane to display DMs but make sure the DMs are clearly distinguishable.
  - ~[ ] **Use Redis for the main message channel and DMs.** Such that there is one global Redis server and many socket.io servers each serving a set of user and basically proxying messages to/from Redis channels.~. Meh.
  - ~[ ] **Proper login with persistent backend.**~. Meh.

## Implementation Notes

### Sessions
In this app, the *web* manages the login and establishes the session. *Only* the web can create a valid session and *only* the web (or indirectly an expiration timer in the session store) can destroy it. But a socket connection know nothing about sessions implicitly, and the WS connection outlive the web session potentially indefinitely. The WS connection should respect the web session, not allowing access unless there is a valid login session. This has to be checked with *every* packet (just like it has to be checked with every web request).

        .-----.               .-----.
        | Web | <-----------> | API |
        '-----'               |     |
                              |     |
            .-----.           |     |
            | WS  | <-------> |     |
            '-----'           '-----'

Alt 1: [SO suggested a ~trick][so1] for using `expressjs-session` session middleware with socket.io:

    const Session = require('express-session'); // https://github.com/expressjs/session
    const session = Session({...})
    io.use((socket, next) => session(socket.request, {}, next));

But this doesn't actually seem work. If your Express application uses the session (~any HTTP request) the session that gets attached to the socket request object by the middleware seems to get detached from the actual storage.

Alt 2: Tried calling `Session.reload(callback)` with *every* socket request:

      socket.use((packet, next) => {
        socket.request.session.reload((err) => {
          if(err) next(err);
          next();
        });
      });

But this lead to stack overflow in express-session(!). Trying to use express-session with socket.io may just be the wrong approach.

Alt 3: With session established by express-session we get these cookies on socket.io connection:

    connect.sid: s:i77nbbCQOjGbchv2s20EVokAgqNyHr2L.MJGdNuNsPQXxmyHtHC8U6BWMnI2xLuHnKyVHRW24wWA
    io: x1VH4cJMfk73GTIxAAAB

"x1VH4cJMfk73GTIxAAAB" is the socket id, "i77nbbCQOjGbchv2s20EVokAgqNyHr2L" is the session id, "MJGdNuNsPQXxmyHtHC8U6BWMnI2xLuHnKyVHRW24wWA" is a cookie signature "connect.sid" is the default name of the session cookie set by expressjs. So it's just a matter of parsing the SID cookie and accessing the session yourself. Express will access the same cookie etc. This works good.

### List of Online Users
See [namespace.clients](https://github.com/socketio/socket.io/blob/master/docs/API.md#namespaceclientscallback).


## Implementation Review

  - Structure would be nicer and up performance if we used simple create-react-app as template basis and did a server side preprocessing build. That's easy enough and worth the effort in IRL.
  - Sharing a session between socket.io and Express is a bit icky. The session can expire according to Express but still be valid according to socket.io unless we explicitly reimplement the session expiration logic in the socket.io middleware - which we don't. Implemented fix is to just keep the session alive so long as there is a live socket.io connection by doing a custom ping to touch the shared session.
  - Not well tested but seems to work.

[socket.io]: https://github.com/socketio/socket.io/blob/master/docs/README.md
[so1]: https://stackoverflow.com/questions/25532692/how-to-share-sessions-with-socket-io-1-x-and-express-4-x?noredirect=1&lq=1
[generateId]: https://stackoverflow.com/questions/7702461/socket-io-custom-client-id
