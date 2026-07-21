import { useState } from "react";
import styled from "styled-components";
import { login, register, storeToken } from "../games/something2/src/js/net/EngineClient.js";

const Screen = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100vh;
  width: 100%;
  background-color: #0f0f1a;
`;

const Card = styled.form`
  display: flex;
  flex-direction: column;
  gap: 1rem;
  width: 320px;
  padding: 2rem;
  background: #1a1a2e;
  border: 2px solid #2e2e3e;
  border-radius: 12px;
`;

const Title = styled.h1`
  color: white;
  margin: 0;
  font-size: 1.6rem;
  text-align: center;
`;

const Field = styled.input`
  padding: 0.75rem 1rem;
  font-size: 1rem;
  border-radius: 8px;
  border: 1px solid #2e2e3e;
  background: #0f0f1a;
  color: white;

  &:focus {
    outline: none;
    border-color: #4a9eff;
  }
`;

const Submit = styled.button`
  padding: 0.8rem 1rem;
  font-size: 1rem;
  font-weight: bold;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  background: #4a9eff;
  color: white;

  &:disabled {
    opacity: 0.6;
    cursor: default;
  }
`;

const Toggle = styled.button`
  background: none;
  border: none;
  color: #4a9eff;
  cursor: pointer;
  font-size: 0.9rem;
`;

const ErrorText = styled.p`
  color: #f87171;
  margin: 0;
  font-size: 0.9rem;
  text-align: center;
`;

// Login / register screen. Pure UI + the two auth calls; the token storage and
// parsing logic lives in (unit-tested) helpers in EngineClient.js. On success
// it stores the returned token and calls onAuthed() so the parent can show the
// game.
export default function Login({ apiUrl, onAuthed }) {
  const [mode, setMode] = useState("login"); // 'login' | 'register'
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const isRegister = mode === "register";

  async function handleSubmit(e) {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const fn = isRegister ? register : login;
      const { token } = await fn(apiUrl, username, password);
      if (!token) throw new Error("no token returned");
      storeToken(token);
      onAuthed();
    } catch (err) {
      setError(err.message || "authentication failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Screen>
      <Card onSubmit={handleSubmit}>
        <Title>{isRegister ? "Create account" : "Sign in"}</Title>

        <Field
          type="text"
          placeholder="Username"
          value={username}
          autoComplete="username"
          onChange={(e) => setUsername(e.target.value)}
        />
        <Field
          type="password"
          placeholder="Password"
          value={password}
          autoComplete={isRegister ? "new-password" : "current-password"}
          onChange={(e) => setPassword(e.target.value)}
        />

        {error && <ErrorText>{error}</ErrorText>}

        <Submit type="submit" disabled={submitting || !username || !password}>
          {submitting ? "…" : isRegister ? "Register" : "Log in"}
        </Submit>

        <Toggle
          type="button"
          onClick={() => { setError(null); setMode(isRegister ? "login" : "register"); }}
        >
          {isRegister ? "Have an account? Sign in" : "Need an account? Register"}
        </Toggle>
      </Card>
    </Screen>
  );
}
