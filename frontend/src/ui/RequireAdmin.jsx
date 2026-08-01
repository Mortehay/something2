import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { guardRedirect } from "./routeGuards";

// The admin panels are addressable now, so a non-admin can type their URL.
// Without this they would render a blank content area. The server's adminGuard
// is still the actual enforcement -- this is UX and defence in depth.
function RequireAdmin() {
  const { authed, isAdmin } = useAuth();
  const to = guardRedirect({ authed, isAdmin, requireAdmin: true });
  return to ? <Navigate to={to} replace /> : <Outlet />;
}

export default RequireAdmin;
