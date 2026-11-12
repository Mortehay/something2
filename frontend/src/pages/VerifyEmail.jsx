import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { verifyEmail } from "../games/something2/src/js/net/accountApi.js";
import { useAuth } from "../context/AuthContext";
import { t } from "../games/something2/src/js/i18n/i18n.js";
import { useLang } from "../games/something2/src/js/i18n/useLang.js";
import { Screen, Card, Title, Notice, ErrorText, Toggle } from "./authCard.jsx";
import { errorText } from "./loginModel.js";

// Target of the emailed /verify-email/<token> link. Consumes the token once,
// then hands over to the login screen, which shows the matching banner.
function VerifyEmail() {
  useLang();
  const { token } = useParams();
  const navigate = useNavigate();
  const { authed, refreshAccount } = useAuth();
  const [error, setError] = useState("");
  const started = useRef(false); // StrictMode runs effects twice; the token is single-use

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    verifyEmail(token)
      .then(async () => {
        // Signed in: the boot /me may have raced this POST and still say unverified; re-read it so the gate lifts.
        if (authed) {
          try { await refreshAccount({ force: true }); } catch { /* the focus refresh still catches up */ }
        }
        navigate("/login?verified=1", { replace: true });
      })
      .catch((err) => {
        // Only a dead token means "expired"; a network blip or server error leaves it usable on reload.
        if (err.code === "link_expired") navigate("/login?link=expired", { replace: true });
        else setError(errorText(err.code, err.retryAfterSec));
      });
  }, [token, navigate, authed, refreshAccount]);

  return (
    <Screen>
      <Card as="div">
        <Title>Something2</Title>
        {error ? (
          <>
            <ErrorText>{error}</ErrorText>
            <Toggle type="button" onClick={() => navigate("/login")}>{t("Back to sign in")}</Toggle>
          </>
        ) : (
          <Notice>{t("Verifying your email…")}</Notice>
        )}
      </Card>
    </Screen>
  );
}

export default VerifyEmail;
