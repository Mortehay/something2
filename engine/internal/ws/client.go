package ws

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	writeWait        = 10 * time.Second
	pongWait         = 60 * time.Second
	pingPeriod       = (pongWait * 9) / 10
	maxMessageSize   = 64 * 1024
	sendQueueSize    = 64
	redisOpTimeout   = 2 * time.Second
	redisPlayerTTL   = 30 * time.Minute
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	// Engine sits behind the same compose network as the frontend dev server;
	// we accept any origin and rely on JWT auth instead.
	CheckOrigin: func(r *http.Request) bool { return true },
}

// Client is a single WebSocket connection. The reader runs in one goroutine,
// the writer in another; both shut down via the same `done` channel.
type Client struct {
	hub    *Hub
	conn   *websocket.Conn
	send   chan []byte
	userID int64
	mapID  string

	closeOnce sync.Once
	done      chan struct{}
}

func newClient(hub *Hub, conn *websocket.Conn, userID int64) *Client {
	return &Client{
		hub:    hub,
		conn:   conn,
		send:   make(chan []byte, sendQueueSize),
		userID: userID,
		done:   make(chan struct{}),
	}
}

func (c *Client) close() {
	c.closeOnce.Do(func() {
		close(c.done)
		_ = c.conn.Close()
	})
}

// enqueue marshals + queues. Drops with a log line if the queue is full
// (slow client) so the broadcaster never blocks.
func (c *Client) enqueue(payload any) {
	body, err := json.Marshal(payload)
	if err != nil {
		log.Printf("ws: marshal: %v", err)
		return
	}
	c.enqueueRaw(body)
}

func (c *Client) enqueueRaw(body []byte) {
	select {
	case c.send <- body:
	default:
		log.Printf("ws: send queue full for user=%d, dropping frame", c.userID)
	}
}

func (c *Client) readPump() {
	defer c.hub.unregister(c)

	c.conn.SetReadLimit(maxMessageSize)
	_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		_, raw, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("ws read user=%d: %v", c.userID, err)
			}
			return
		}
		var msg Inbound
		if err := json.Unmarshal(raw, &msg); err != nil {
			c.enqueue(ErrorPayload{Type: MsgError, Message: "invalid json"})
			continue
		}
		c.hub.HandleInbound(c, msg)
	}
}

func (c *Client) writePump() {
	pingTicker := time.NewTicker(pingPeriod)
	defer func() {
		pingTicker.Stop()
		c.close()
	}()

	for {
		select {
		case <-c.done:
			return
		case msg, ok := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				_ = c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-pingTicker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
