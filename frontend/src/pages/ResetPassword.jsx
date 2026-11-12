import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { checkResetToken, resetPassword } from "../games/something2/src/js/net/accountApi.js";
import { t } from "../games/something2/src/js/i18n/i18n.js";
import { useLang } from "../games/something2/src/js/i18n/useLang.js";
import { Screen, Card, Title, Field, Submit, ErrorText, Notice, Toggle } from "./authCard.jsx";
import { errorText } from "./loginModel.js";

// Target of the emailed /reset-password/<token> link. A dead link goes back to
// the login screen; otherwise a new-password form (the server only requires a
// non-empty password, so the client checks non-empty + match).
function ResetPassword() {
  useLang();
  const { token } = useParams();
  const navigate = useNavigate();
  const [live, setLive] = useState(false);
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const checked = useRef(false);

  useEffect(() => {
    if (checked.current) return;
    checked.current = true;
    checkResetToken(token)
      .then((r) => {
        if (r && r.live) setLive(true);
        else navigate("/login?link=expired", { replace: true });
      })
      .catch((err) => setError(errorText(err.code, err.retryAfterSec))); // network/server error: the link may still be live
  }, [token, navigate]);

  async function submit(e) {
    e.preventDefault();
    if (!password) return setError(errorText("password is required"));
    if (password !== repeat) return setError(t("The passwords don't match"));
    setError("");
    setBusy(true);
    try {
      await resetPassword(token, password);
      navigate("/login?reset=1", { replace: true });
    } catch (err) {
      if (err.code === "link_expired") navigate("/login?link=expired", { replace: true });
      else setError(errorText(err.code, err.retryAfterSec));
      setBusy(false);
    }
  }

  if (!live) {
    return (
      <Screen>
        <Card as="div">
          <Title>Something2</Title>
          {error ? (
            <>
              <ErrorText>{error}</ErrorText>
              <Toggle type="button" onClick={() => window.location.reload()}>{t("Try again")}</Toggle>
            </>
          ) : (
            <Notice>{t("Checking your link…")}</Notice>
          )}
        </Card>
      </Screen>
    );
  }
  return (
    <Screen>
      <Card onSubmit={submit}>
        <Title>{t("Set a new password")}</Title>
        <Field type="password" placeholder={t("New password")} autoComplete="new-password" autoFocus
          value={password} onChange={(e) => setPassword(e.target.value)} />
        <Field type="password" placeholder={t("Repeat new password")} autoComplete="new-password"
          value={repeat} onChange={(e) => setRepeat(e.target.value)} />
        {error && <ErrorText>{error}</ErrorText>}
        <Submit type="submit" disabled={busy}>{t("Change password")}</Submit>
      </Card>
    </Screen>
  );
}

export default ResetPassword;
