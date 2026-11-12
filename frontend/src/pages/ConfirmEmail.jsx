import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import toast from "react-hot-toast";
import { peekEmailChange, confirmEmailChange } from "../games/something2/src/js/net/accountApi.js";
import { useAuth } from "../context/AuthContext";
import { t } from "../games/something2/src/js/i18n/i18n.js";
import { useLang } from "../games/something2/src/js/i18n/useLang.js";
import { Screen, Card, Title, Notice, ErrorText, Toggle, Submit } from "./authCard.jsx";
import { errorText } from "./loginModel.js";

// Target of the emailed /confirm-email/<token> link. A GET never consumes the
// token (mail scanners prefetch links): load only PEEKS at the new address, and
// the single-use POST fires from the Confirm button.
function ConfirmEmail() {
  useLang();
  const { token } = useParams();
  const navigate = useNavigate();
  const { authed, refreshAccount } = useAuth();
  const [email, setEmail] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const started = useRef(false); // StrictMode runs effects twice

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    peekEmailChange(token)
      .then((r) => {
        if (r && r.live && r.email) setEmail(r.email);
        else navigate("/login?link=expired", { replace: true });
      })
      .catch((err) => {
        if (err.code === "link_expired") navigate("/login?link=expired", { replace: true });
        else setError(errorText(err.code, err.retryAfterSec));
      });
  }, [token, navigate]);

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await confirmEmailChange(token);
      if (authed) {
        try { await refreshAccount({ force: true }); } catch { /* focus refresh catches up */ }
        toast.success(t("Email changed"));
        navigate("/game/profile", { replace: true });
      } else {
        navigate("/login?verified=1", { replace: true });
      }
    } catch (err) {
      if (err.code === "link_expired") { navigate("/login?link=expired", { replace: true }); return; }
      setError(errorText(err.code, err.retryAfterSec));
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Card as="div">
        <Title>Something2</Title>
        {email && (
          <>
            <Notice>{t("Make {email} the email for your account?", { email })}</Notice>
            <Submit type="button" onClick={confirm} disabled={busy}>{t("Confirm")}</Submit>
          </>
        )}
        {!email && !error && <Notice>{t("Checking your link…")}</Notice>}
        {error && <ErrorText>{error}</ErrorText>}
        {(error || email) && (
          <Toggle type="button" onClick={() => navigate(authed ? "/game" : "/login")}>
            {email ? t("Not now") : t("Back to sign in")}
          </Toggle>
        )}
      </Card>
    </Screen>
  );
}

export default ConfirmEmail;
