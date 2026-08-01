import { useEffect, useRef, useState } from "react";
import styled from "styled-components";
import { HiOutlineUser } from "react-icons/hi";
import DarkModeToggle from "./DarkModeToggle";
import { useAuth } from "../context/AuthContext";

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

const Menu = styled.ul`
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

    &:hover { background-color: var(--color-grey-50); }
`;

function HeaderMenu() {
    const { username, signOut } = useAuth();
    const [open, setOpen] = useState(false);
    const wrapperRef = useRef(null);

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

    return (
        <StyledHeaderMenu>
            <UserWrapper ref={wrapperRef}>
                <Chip
                    onClick={() => setOpen((v) => !v)}
                    aria-haspopup="menu"
                    aria-expanded={open}
                >
                    <HiOutlineUser />
                    <span>{username ?? 'Account'}</span>
                </Chip>
                {open && (
                    <Menu role="menu">
                        <li>
                            <MenuItem role="menuitem" onClick={signOut}>Sign out</MenuItem>
                        </li>
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
