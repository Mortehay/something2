package auth

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/golang-jwt/jwt/v5"
)

type Claims struct {
	UserID   int64  `json:"user_id"`
	Username string `json:"username,omitempty"`
	jwt.RegisteredClaims
}

type ctxKey struct{}

var claimsCtxKey = ctxKey{}

// Validate parses a HS256-signed JWT using the shared secret. The token may be
// supplied as a raw string (no "Bearer " prefix).
func Validate(secret []byte, raw string) (*Claims, error) {
	if raw == "" {
		return nil, errors.New("missing token")
	}
	claims := &Claims{}
	token, err := jwt.ParseWithClaims(raw, claims, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, errors.New("unexpected signing method")
		}
		return secret, nil
	})
	if err != nil {
		return nil, err
	}
	if !token.Valid {
		return nil, errors.New("invalid token")
	}
	if claims.UserID == 0 {
		// Fall back to "sub" if user_id wasn't a numeric claim.
		if claims.Subject == "" {
			return nil, errors.New("token missing user_id/sub")
		}
	}
	return claims, nil
}

// Middleware extracts a JWT from `Authorization: Bearer <t>` or `?token=<t>`
// and stores claims on the request context.
func Middleware(secret []byte, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw := tokenFromRequest(r)
		claims, err := Validate(secret, raw)
		if err != nil {
			http.Error(w, "unauthorized: "+err.Error(), http.StatusUnauthorized)
			return
		}
		ctx := context.WithValue(r.Context(), claimsCtxKey, claims)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func tokenFromRequest(r *http.Request) string {
	if h := r.Header.Get("Authorization"); h != "" {
		if strings.HasPrefix(h, "Bearer ") {
			return strings.TrimPrefix(h, "Bearer ")
		}
		return h
	}
	return r.URL.Query().Get("token")
}

func FromContext(ctx context.Context) (*Claims, bool) {
	c, ok := ctx.Value(claimsCtxKey).(*Claims)
	return c, ok
}
