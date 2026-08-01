import styled from "styled-components";
import { HiOutlineArrowRightOnRectangle } from "react-icons/hi2";
import Logo from "./Logo";
import MainNav from "./MainNav";
import { useAuth } from "../context/AuthContext";

const StyledSidebar = styled.aside`
    background-color: var(--color-grey-0);
    padding: 3.2rem 0;
    border-right: 1px solid var(--color-grey-100);
    grid-row:  1 / -1;
    display:flex;
    flex-direction:column;
    gap: 3.2rem;
    overflow-y: auto;
`;

// margin-top:auto pins this to the bottom however few nav entries render above.
const SignOutButton = styled.button`
    margin-top: auto;
    display: flex;
    align-items: center;
    gap: 1.2rem;
    width: 100%;
    padding: 1rem 2.4rem;
    background: none;
    border: none;
    border-top: 1px solid var(--color-grey-100);
    color: var(--color-grey-600);
    font-size: 1.5rem;
    font-weight: 500;
    font-family: inherit;
    cursor: pointer;
    transition: all 0.3s;

    &:hover {
      color: var(--color-grey-800);
      background-color: var(--color-grey-50);
    }

    & svg {
      width: 2.2rem;
      height: 2.2rem;
      color: var(--color-grey-400);
    }
`;

function Sidebar() {
    const { signOut } = useAuth();
    return (
        <StyledSidebar>
            <Logo/>
            <MainNav/>
            <SignOutButton onClick={signOut}>
                <HiOutlineArrowRightOnRectangle/>
                <span>Sign out</span>
            </SignOutButton>
        </StyledSidebar>
    )
}

export default Sidebar;
