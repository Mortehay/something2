package ws

import (
	"log"
	"net/http"

	"github.com/something2/engine/internal/auth"
)

// HandleWS upgrades the HTTP request to a WebSocket and starts the read/write
// pumps. JWT validation must already have happened in middleware.
func (h *Hub) HandleWS(w http.ResponseWriter, r *http.Request) {
	claims, ok := auth.FromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	userID := claims.UserID
	if userID == 0 {
		http.Error(w, "missing user_id claim", http.StatusUnauthorized)
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("ws upgrade user=%d: %v", userID, err)
		return
	}

	c := newClient(h, conn, userID)
	h.register(c)
	go c.writePump()
	go c.readPump()
}
