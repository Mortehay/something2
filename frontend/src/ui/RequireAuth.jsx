import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { guardRedirect } from "./routeGuards";
import { gateStep } from "./emailGateModel";
import EmailGate from "./EmailGate";

// Wraps everything behind the sign-in wall. Rendering the login screen OUTSIDE
// the app layout (rather than inside Main, as it used to be) means a signed-out
// visitor doesn't get an empty sidebar and header framing the login form.
//
// When the backend's email gate is active and the account has no verified email,
// the gate is rendered INSTEAD of the Outlet, so nothing behind it (the game,
// its WebSocket) ever mounts. While /me is still unanswered we render nothing
// for the same reason. A FAILED /me read fails open (Outlet): the server enforces
// the gate itself, and a gated 403 brings the popup up.
function RequireAuth() {
  const { authed, account, probeStatus } = useAuth();
  const to = guardRedirect({ authed, isAdmin: false });
  if (to) return <Navigate to={to} replace />;
  const step = gateStep(account, probeStatus);
  if (step === "loading") return null;
  if (step !== "none") return <EmailGate step={step} />;
  return <Outlet />;
}

export default RequireAuth;
