package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func makeToken(t *testing.T, secret []byte, userID int64, exp time.Duration) string {
	t.Helper()
	claims := Claims{
		UserID: userID,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(exp)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	s, err := tok.SignedString(secret)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return s
}

func TestValidate_HappyPath(t *testing.T) {
	secret := []byte("test-secret-with-enough-length-xx")
	tok := makeToken(t, secret, 42, time.Minute)

	c, err := Validate(secret, tok)
	if err != nil {
		t.Fatalf("validate: %v", err)
	}
	if c.UserID != 42 {
		t.Fatalf("user_id=%d want 42", c.UserID)
	}
}

func TestValidate_BadSignature(t *testing.T) {
	tok := makeToken(t, []byte("right-secret-that-is-long-enough"), 1, time.Minute)
	if _, err := Validate([]byte("wrong-secret-also-long-enough!!!"), tok); err == nil {
		t.Fatal("expected error for bad signature")
	}
}

func TestValidate_Expired(t *testing.T) {
	secret := []byte("test-secret-with-enough-length-xx")
	tok := makeToken(t, secret, 1, -time.Minute)
	if _, err := Validate(secret, tok); err == nil {
		t.Fatal("expected expired token to fail")
	}
}

func TestMiddleware_RejectsMissingToken(t *testing.T) {
	secret := []byte("test-secret-with-enough-length-xx")
	h := Middleware(secret, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}))
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/ws", nil)
	h.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("got %d want 401", w.Code)
	}
}

func TestMiddleware_AcceptsBearer(t *testing.T) {
	secret := []byte("test-secret-with-enough-length-xx")
	tok := makeToken(t, secret, 7, time.Minute)
	called := false
	h := Middleware(secret, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		c, ok := FromContext(r.Context())
		if !ok || c.UserID != 7 {
			t.Fatalf("claims missing or wrong: %+v ok=%v", c, ok)
		}
	}))
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/ws", nil)
	r.Header.Set("Authorization", "Bearer "+tok)
	h.ServeHTTP(w, r)
	if !called {
		t.Fatal("next handler not called")
	}
}

func TestMiddleware_AcceptsQueryParam(t *testing.T) {
	secret := []byte("test-secret-with-enough-length-xx")
	tok := makeToken(t, secret, 9, time.Minute)
	called := false
	h := Middleware(secret, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
	}))
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/ws?token="+tok, nil)
	h.ServeHTTP(w, r)
	if !called || w.Code == http.StatusUnauthorized {
		t.Fatalf("query token rejected, code=%d", w.Code)
	}
}
