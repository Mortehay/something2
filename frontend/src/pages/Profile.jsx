import { useCallback, useEffect, useState } from "react";
import styled from "styled-components";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { useAuth } from "../context/AuthContext";
import {
  setEmail, resendVerification, changeEmail, cancelEmailChange, changePassword,
  listInvites, createInvite, revokeInvite,
} from "../games/something2/src/js/net/accountApi.js";
import { t } from "../games/something2/src/js/i18n/i18n.js";
import { useLang } from "../games/something2/src/js/i18n/useLang.js";
import { errorText } from "./loginModel.js";
import {
  emailSectionState, inviteStatus, canCreateInvite, formatWait, formatCreatedAt,
} from "./profileModel.js";

const RESEND_COOLDOWN_SEC = 60;

// Same absolute-fill page as the player world map: the GameShell content area has no definite height.
const Page = styled.div`
  position: absolute; inset: 0; box-sizing: border-box;
  padding: 2rem; overflow-y: auto;
  color: var(--s2-text); background-color: var(--s2-surface);
`;
const Inner = styled.div`max-width: 640px; margin: 0 auto; display: flex; flex-direction: column; gap: 1.6rem;`;
const PageTitle = styled.h2`margin: 0; color: var(--s2-text-strong);`;
const Section = styled.section`
  display: flex; flex-direction: column; gap: 0.8rem;
  padding: 1.2rem 1.4rem;
  background: var(--s2-surface-raised); border: 1px solid var(--s2-border); border-radius: 8px;
`;
const SectionTitle = styled.h3`margin: 0; font-size: 1.1em; color: var(--s2-text-strong);`;
const Dim = styled.div`color: var(--s2-text-dim); font-size: 0.9em;`;
const Value = styled.div`color: var(--s2-text); word-break: break-all;`;
const Form = styled.form`display: flex; flex-direction: column; gap: 0.6rem;`;
const Input = styled.input`
  padding: 0.55rem 0.8rem; font-size: 1em; font-family: inherit;
  border-radius: 6px; border: 1px solid var(--s2-border-strong);
  background: var(--s2-bg-sunken); color: var(--s2-text);
  &:focus { outline: none; border-color: var(--s2-accent); }
  &:disabled { opacity: 0.6; }
`;
const Btn = styled.button`
  align-self: flex-start; padding: 0.5rem 1rem; font-size: 0.95em; font-family: inherit;
  border-radius: 6px; border: 1px solid transparent; cursor: pointer;
  background: var(--s2-accent); color: var(--s2-on-accent);
  &:disabled { opacity: 0.5; cursor: default; }
`;
const GhostBtn = styled(Btn)`
  background: transparent; color: var(--s2-text); border-color: var(--s2-border-strong);
`;
const DangerBtn = styled(GhostBtn)`color: var(--s2-danger); border-color: var(--s2-danger);`;
const Err = styled.div`color: var(--s2-danger); font-size: 0.9em;`;
const Ok = styled.div`color: var(--s2-accent); font-size: 0.9em;`;
const CodeRow = styled.li`
  display: flex; flex-wrap: wrap; gap: 0.6rem; align-items: center;
  padding: 0.5rem 0; border-top: 1px solid var(--s2-hairline);
`;
const Code = styled.code`font-size: 1em; color: var(--s2-text-strong);`;
const CodeList = styled.ul`list-style: none; margin: 0; padding: 0;`;

// Counts down from n to 0 once a second; returns [secondsLeft, start].
function useCooldown() {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (left <= 0) return undefined;
    const id = setTimeout(() => setLeft((c) => c - 1), 1000);
    return () => clearTimeout(id);
  }, [left]);
  return [left, setLeft];
}

function NameSection({ username }) {
  return (
    <Section aria-labelledby="profile-name">
      <SectionTitle id="profile-name">{t("Name")}</SectionTitle>
      <Value>{username ?? ""}</Value>
    </Section>
  );
}

// New address + current password. In the 'pending' state it is prefilled with the waiting address and
// doubles as "Resend" (the server replaces the older link).
function ChangeEmailForm({ account, onDone, initialEmail = "", submitLabel }) {
  const [email, setEmailValue] = useState(initialEmail);
  const [password, setPassword] = useState("");
  // Two steps: the address alone first, then the current password to confirm it. One visible
  // field per step also stops the browser autofilling the account name into the email box.
  const [step, setStep] = useState("email");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [cooldown, setCooldown] = useCooldown();
  const off = !account.mailEnabled;
  const toPassword = (e) => {
    e.preventDefault();
    if (off || cooldown > 0 || !email.trim()) return;
    setError("");
    setStep("password");
  };
  const back = () => { setStep("email"); setPassword(""); setError(""); };
  const submit = async (e) => {
    e.preventDefault();
    if (busy || cooldown > 0 || off) return;
    setBusy(true);
    setError("");
    try {
      await changeEmail(email.trim(), password);
      setPassword("");
      setStep("email");
      setCooldown(RESEND_COOLDOWN_SEC);
      toast.success(t("Check the new address for a confirmation link"));
      await onDone();
    } catch (err) {
      if (err.code === "resend_cooldown" && err.retryAfterSec) setCooldown(Math.ceil(err.retryAfterSec));
      if (err.code !== "wrong_password") setStep("email");
      setError(errorText(err.code, err.retryAfterSec));
    } finally {
      setBusy(false);
    }
  };
  if (step === "password") {
    return (
      <Form onSubmit={submit}>
        <Dim>{t("New email: {email}", { email: email.trim() })}</Dim>
        {/* For password managers: which account this password belongs to. */}
        <input type="text" name="username" autoComplete="username" value={account.username || ""}
          readOnly hidden aria-hidden="true" />
        <Input type="password" autoComplete="current-password" placeholder={t("Current password")}
          aria-label={t("Current password")} value={password} autoFocus
          onChange={(e) => setPassword(e.target.value)} required disabled={off} />
        {error && <Err role="alert">{error}</Err>}
        <Btn type="submit" disabled={off || busy || !password}>{t("Confirm")}</Btn>
        <GhostBtn type="button" onClick={back} disabled={busy}>{t("Cancel")}</GhostBtn>
      </Form>
    );
  }
  return (
    <Form onSubmit={toPassword}>
      <Input type="email" name="new-email" autoComplete="off" placeholder={t("New email")} aria-label={t("New email")}
        value={email} onChange={(e) => setEmailValue(e.target.value)} required disabled={off} />
      {error && <Err role="alert">{error}</Err>}
      <Btn type="submit" disabled={off || cooldown > 0 || !email.trim()}>
        {cooldown > 0 ? t("Resend in {seconds}s", { seconds: cooldown }) : (submitLabel ?? t("Change email"))}
      </Btn>
    </Form>
  );
}

function EmailSection({ account, refreshAccount }) {
  const state = emailSectionState(account);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [cooldown, setCooldown] = useCooldown();
  const reload = useCallback(() => refreshAccount({ force: true }), [refreshAccount]);
  const mailOff = !account.mailEnabled;

  const run = async (fn, { cool = false } = {}) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setSent(false);
    try {
      await fn();
      if (cool) setCooldown(RESEND_COOLDOWN_SEC);
      await reload();
    } catch (err) {
      if (err.code === "resend_cooldown" && err.retryAfterSec) setCooldown(Math.ceil(err.retryAfterSec));
      setError(errorText(err.code, err.retryAfterSec));
    } finally {
      setBusy(false);
    }
  };

  let body;
  if (state === "add") {
    body = (
      <Form onSubmit={(e) => { e.preventDefault(); run(() => setEmail(value.trim()), { cool: true }); }}>
        <Dim>{t("No email on this account yet.")}</Dim>
        <Input type="email" autoComplete="email" placeholder={t("Email")} aria-label={t("Email")}
          value={value} onChange={(e) => setValue(e.target.value)} required disabled={mailOff} />
        <Btn type="submit" disabled={mailOff || busy || !value.trim()}>{t("Add email")}</Btn>
      </Form>
    );
  } else if (state === "verify") {
    body = (
      <>
        <Value>{account.email}</Value>
        <Dim>{t("Not verified — check your inbox (and spam) for the link.")}</Dim>
        {sent && <Ok>{t("Email sent")}</Ok>}
        <Btn type="button" disabled={mailOff || busy || cooldown > 0}
          onClick={() => run(async () => { await resendVerification(); setSent(true); }, { cool: true })}>
          {cooldown > 0 ? t("Resend in {seconds}s", { seconds: cooldown }) : t("Resend")}
        </Btn>
      </>
    );
  } else if (state === "pending") {
    body = (
      <>
        <Value>{account.email}</Value>
        <Dim>{t("Waiting for you to confirm {email} — open the link we sent there. Your current email stays until then.", { email: account.pendingEmail })}</Dim>
        <Btn type="button" disabled={busy} onClick={() => run(() => cancelEmailChange())}>
          {t("Cancel change")}
        </Btn>
        <Dim>{t("To send the link again, enter your password.")}</Dim>
        <ChangeEmailForm account={account} onDone={reload} initialEmail={account.pendingEmail}
          submitLabel={t("Resend")} />
      </>
    );
  } else {
    body = (
      <>
        <Value>{account.email}</Value>
        <Dim>{t("Verified")}</Dim>
        <ChangeEmailForm account={account} onDone={reload} />
      </>
    );
  }

  return (
    <Section aria-labelledby="profile-email">
      <SectionTitle id="profile-email">{t("Email")}</SectionTitle>
      {mailOff && <Dim>{t("Email isn't set up on this server, so email changes are unavailable.")}</Dim>}
      {body}
      {error && <Err role="alert">{error}</Err>}
    </Section>
  );
}

function PasswordSection({ replaceToken }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mismatch = repeat !== "" && repeat !== next;
  const submit = async (e) => {
    e.preventDefault();
    if (busy || next !== repeat) return;
    setBusy(true);
    setError("");
    try {
      const { token } = await changePassword(current, next);
      // Every other session is revoked now; keep this one by switching to the fresh token.
      if (!replaceToken(token)) { setError(errorText("unknown")); return; }
      setCurrent(""); setNext(""); setRepeat("");
      toast.success(t("Password changed"));
    } catch (err) {
      setError(errorText(err.code, err.retryAfterSec));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section aria-labelledby="profile-password">
      <SectionTitle id="profile-password">{t("Password")}</SectionTitle>
      <Form onSubmit={submit}>
        <Input type="password" autoComplete="current-password" placeholder={t("Current password")}
          aria-label={t("Current password")} value={current} onChange={(e) => setCurrent(e.target.value)} required />
        <Input type="password" autoComplete="new-password" placeholder={t("New password")}
          aria-label={t("New password")} value={next} onChange={(e) => setNext(e.target.value)} required />
        <Input type="password" autoComplete="new-password" placeholder={t("Repeat new password")}
          aria-label={t("Repeat new password")} value={repeat} onChange={(e) => setRepeat(e.target.value)} required />
        {mismatch && <Err>{t("The new passwords don't match")}</Err>}
        {error && <Err role="alert">{error}</Err>}
        <Btn type="submit" disabled={busy || !current || !next || !repeat || mismatch}>{t("Change password")}</Btn>
      </Form>
      <Dim>{t("Changing your password signs you out everywhere else.")}</Dim>
    </Section>
  );
}

function InvitesSection() {
  const qc = useQueryClient();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const q = useQuery({ queryKey: ["profile-invites"], queryFn: listInvites, staleTime: 0 });
  const invites = q.data?.invites ?? [];
  const remaining = q.data ? q.data.remainingToday : undefined;
  const nextWait = remaining === 0 ? formatWait(q.data?.nextAvailableInSec) : null;

  const act = async (fn) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (err) {
      setError(errorText(err.code, err.retryAfterSec));
    } finally {
      await qc.invalidateQueries({ queryKey: ["profile-invites"] });   // a 409/404/429 means our list was stale
      setBusy(false);
    }
  };
  const copy = async (code) => {
    try {
      await navigator.clipboard.writeText(code);
      toast.success(t("Copied"));
    } catch {
      toast.error(t("Couldn't copy — select the code and copy it by hand"));
    }
  };
  const statusText = { unused: t("Unused"), used: t("Used"), revoked: t("Revoked") };

  return (
    <Section aria-labelledby="profile-invites">
      <SectionTitle id="profile-invites">{t("Invite codes")}</SectionTitle>
      <Dim>
        {remaining === null
          ? t("No limit on invite codes")
          : remaining === undefined ? "" : t("{count} left in the last 24 hours", { count: remaining })}
      </Dim>
      {error && <Err role="alert">{error}</Err>}
      <Btn type="button" disabled={busy || q.isLoading || !canCreateInvite(remaining === undefined ? 0 : remaining)}
        onClick={() => act(() => createInvite())}>
        {t("Create invite code")}
      </Btn>
      {nextWait && <Dim>{t("Next code in {wait}", { wait: nextWait })}</Dim>}
      {q.isError && <Err role="alert">{errorText(q.error?.code)}</Err>}
      {!q.isLoading && !q.isError && invites.length === 0 && <Dim>{t("No invite codes yet.")}</Dim>}
      <CodeList>
        {invites.map((inv) => {
          const status = inviteStatus(inv);
          return (
            <CodeRow key={inv.code}>
              <Code>{inv.code}</Code>
              {formatCreatedAt(inv.createdAt) && (
                <Dim title={String(inv.createdAt)}>{t("Created {when}", { when: formatCreatedAt(inv.createdAt) })}</Dim>
              )}
              <Dim>
                {status === "used" && inv.usedBy
                  ? t("Used by {name}", { name: inv.usedBy })
                  : statusText[status]}
              </Dim>
              {status === "unused" && (
                <>
                  <GhostBtn type="button" onClick={() => copy(inv.code)}>{t("Copy")}</GhostBtn>
                  <DangerBtn type="button" disabled={busy} onClick={() => act(() => revokeInvite(inv.code))}>
                    {t("Revoke")}
                  </DangerBtn>
                </>
              )}
            </CodeRow>
          );
        })}
      </CodeList>
    </Section>
  );
}

function Profile() {
  useLang();
  const { account, username, refreshAccount, replaceToken } = useAuth();
  // Re-read /me on arrival: pendingEmail / emailVerified may have moved since the boot read.
  useEffect(() => { refreshAccount({ force: true }); }, [refreshAccount]);
  return (
    <Page>
      <Inner>
        <PageTitle>{t("Profile")}</PageTitle>
        <NameSection username={username} />
        {account ? <EmailSection account={account} refreshAccount={refreshAccount} /> : null}
        <PasswordSection replaceToken={replaceToken} />
        <InvitesSection />
      </Inner>
    </Page>
  );
}

export default Profile;
