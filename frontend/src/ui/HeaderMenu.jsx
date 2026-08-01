import { useEffect, useRef, useState } from "react";
import styled from "styled-components";
import { HiOutlineUser } from "react-icons/hi";
import DarkModeToggle from "./DarkModeToggle";
import { useAuth } from "../context/AuthContext";
import { menuKeyAction } from "./menuKeys";

const StyledHeaderMenu = styled.ul`
    display: flex;
    align-items: center;
    gap: 0.4rem;
`;

const UserWrapper = styled.li`
    position: relative;
`;

const Chip = styled.button`
    display: flex;
    align-items: center;
    gap: 0.8rem;
    padding: 0.6rem 1.2rem;
    background: none;
    border: none;
    border-radius: var(--border-radius-sm);
    color: var(--color-grey-600);
    font-size: 1.4rem;
    font-family: inherit;
    cursor: pointer;
    transition: all 0.2s;

    &:hover { background-color: var(--color-grey-100); }

    & svg {
      width: 2.2rem;
      height: 2.2rem;
      color: var(--color-brand-600);
    }
`;

// A <div>, not a <ul>: the only children role="menu" permits are menuitem /
// menuitemradio / menuitemcheckbox (or groups of them). Wrapping each item in an
// <li> put a non-menuitem element between the menu and its items -- exactly the
// structure assistive tech walks to count and announce them.
const Menu = styled.div`
    position: absolute;
    top: calc(100% + 0.4rem);
    right: 0;
    z-index: 2100; /* Above admin modals (2000) and GameShell help overlay (300/400) */
    min-width: 16rem;
    padding: 0.4rem;
    background-color: var(--color-grey-0);
    border: 1px solid var(--color-grey-100);
    border-radius: var(--border-radius-sm);
    box-shadow: var(--shadow-md);
`;

const MenuItem = styled.button`
    display: block;
    width: 100%;
    padding: 0.8rem 1.2rem;
    text-align: left;
    background: none;
    border: none;
    border-radius: var(--border-radius-sm);
    color: var(--color-grey-600);
    font-size: 1.4rem;
    font-family: inherit;
    cursor: pointer;

    &:hover, &:focus-visible { background-color: var(--color-grey-50); }
`;

const MENU_ID = "header-account-menu";

function HeaderMenu() {
    const { username, signOut } = useAuth();
    const [open, setOpen] = useState(false);
    const wrapperRef = useRef(null);
    const menuRef = useRef(null);
    const chipRef = useRef(null);
    // Which item to focus once the menu has actually rendered. Set by the key
    // handler and consumed by the effect below, because on the opening keystroke
    // the menu does not exist yet to receive focus.
    const pendingFocusRef = useRef(null);

    // Click-away close. Without it the menu stays open behind whatever the user
    // clicks next, including the game canvas.
    useEffect(() => {
        if (!open) return;
        const onDocClick = (e) => {
            if (!wrapperRef.current?.contains(e.target)) setOpen(false);
        };
        document.addEventListener('click', onDocClick);
        return () => document.removeEventListener('click', onDocClick);
    }, [open]);

    const menuItems = () => [...(menuRef.current?.querySelectorAll('[role="menuitem"]') ?? [])];

    // Deliver the focus the opening keystroke asked for, now that the menu is in
    // the DOM. Opening by CLICK leaves pendingFocus null, so a pointer user is
    // not yanked into the list.
    useEffect(() => {
        if (!open) return;
        const index = pendingFocusRef.current;
        pendingFocusRef.current = null;
        if (index != null) menuItems()[index]?.focus();
    }, [open]);

    // One handler on the wrapper so it sees keys whether focus sits on the
    // trigger or inside the menu. The rule itself lives in menuKeys.js (pure and
    // unit-tested); this only maps the returned action onto DOM effects.
    const onKeyDown = (e) => {
        const list = menuItems();
        const action = menuKeyAction({
            key: e.key,
            open,
            focusedIndex: list.indexOf(document.activeElement),
            // While closed there is no rendered list to measure, but the trigger
            // must still be openable -- 1 stands in for "there is something to
            // open onto", and the real count takes over once it renders.
            itemCount: open ? list.length : 1,
        });
        if (!action) return;

        if (action.type === 'open') {
            e.preventDefault();
            pendingFocusRef.current = action.index;
            setOpen(true);
        } else if (action.type === 'focus') {
            e.preventDefault();
            list[action.index]?.focus();
        } else if (action.type === 'close') {
            e.preventDefault();
            setOpen(false);
            chipRef.current?.focus();   // backing out lands you where you started
        } else if (action.type === 'dismiss') {
            setOpen(false);             // no preventDefault: let Tab move on
        }
    };

    return (
        <StyledHeaderMenu>
            <UserWrapper ref={wrapperRef} onKeyDown={onKeyDown}>
                <Chip
                    ref={chipRef}
                    onClick={() => setOpen((v) => !v)}
                    aria-haspopup="menu"
                    aria-expanded={open}
                    aria-controls={open ? MENU_ID : undefined}
                >
                    <HiOutlineUser />
                    <span>{username ?? 'Account'}</span>
                </Chip>
                {open && (
                    <Menu id={MENU_ID} ref={menuRef} role="menu" aria-label="Account">
                        <MenuItem role="menuitem" onClick={signOut}>Sign out</MenuItem>
                    </Menu>
                )}
            </UserWrapper>
            <li>
                <DarkModeToggle />
            </li>
        </StyledHeaderMenu>
    );
}
export default HeaderMenu;
