import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { guardRedirect } from "./routeGuards";

// Wraps everything behind the sign-in wall. Rendering the login screen OUTSIDE
// the app layout (rather than inside Main, as it used to be) means a signed-out
// visitor doesn't get an empty sidebar and header framing the login form.
function RequireAuth() {
  const { authed } = useAuth();
  const to = guardRedirect({ authed, isAdmin: false });
  return to ? <Navigate to={to} replace /> : <Outlet />;
}

export default RequireAuth;
