import { Navigate } from "react-router-dom";
import Login from "./Login";
import { API_URL } from "../config";
import { useAuth } from "../context/AuthContext";

// The login screen as a route, rendered OUTSIDE AppLayout so no sidebar or
// header frames it. Login.jsx stores the token itself and then calls
// onAuthed(), so signIn() just re-reads it from storage.
function LoginRoute() {
  const { authed, signIn } = useAuth();
  if (authed) return <Navigate to="/game" replace />;
  return <Login apiUrl={API_URL} onAuthed={() => signIn()} />;
}

export default LoginRoute;
