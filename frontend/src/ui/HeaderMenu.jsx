import styled from "styled-components";
import { HiOutlineUser } from "react-icons/hi";
import ButtonIcon from "./ButtonIcon";
import { useNavigate } from "react-router-dom";
import DarkModeToggle from "./DarkModeToggle";

const StyledHeaderMenu = styled.ul`
    display: flex;
    gap: 0.4rem;
`;

function HeaderMenu() {
    const navigate = useNavigate();
    const onUserClick = () => navigate('/account');
    return (
        <StyledHeaderMenu>

            <li>
                <ButtonIcon onClick={onUserClick}><HiOutlineUser /></ButtonIcon>
            </li>
            <li>
                <DarkModeToggle />
            </li>
   
        </StyledHeaderMenu>
    );
}
export default HeaderMenu;