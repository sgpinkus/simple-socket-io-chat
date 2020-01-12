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

### List of Online Users
Whether a user is logged in or not is indicated by the existence of a session with auth=1. connect-redis will automatically expire session based on the cookie setting `maxAge` and/or `expires`. But we also need to keep global information about the users that is not private to each user session. Specifically, a set of logged in users. If a user requests to logout explicitly we know who the user is and we can explicitly delete all necessary data. However connect-redis is coming along and only deleting part of the user data without giving us an opportunity to clean up elsewhere (there is no hook into the delete process AFAIK). How to solve:

  - Alt 1: Set a TTL on other data too and essentially mirror what redis-connect is doing setting a up period purge job and touching TTL on new user activity.
  - Alt 2: Don't use separate data structures. Store everything in session data and construct a users collection in the application space by enumerating the session store.
  - Alt 3: Redis notifications.
  - Alt 4: Redis notifications and periodically A1 as well.

Going with A2. A1 present possibility of a race. I'd probably do A4 in a production system. Apparently notifications are not completely reliable so if you implemented A3 you'd end up having to do A4 anyway. A2 is the simplest but not very efficient and pretty hacky. Meh.

## Implementation Review

  - Structure would be nicer and up performance if we used simple create-react-app as template basis and did a server side preprocessing build. That's easy enough and worth the effort in IRL.
  - Sharing a session between socket.io and Express is a bit icky. The session can expire according to Express but still be valid according to socket.io unless we explicitly reimplement the session expiration logic in the socket.io middleware - which we don't. Implemented fix is to just keep the session alive so long as there is a live socket.io connection by doing a custom ping to touch the shared session.
  - Not well tested but seems to work.

[socket.io]: https://github.com/socketio/socket.io/blob/master/docs/README.md
