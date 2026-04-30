import styled from "styled-components";
import LoginForm from "../games/something2/Something2";
import Logo from "../ui/Logo";
import Heading from "../ui/Heading";
import Something2 from "../games/something2/Something2";


const LoginLayout = styled.main`
  min-height: 100vh;
  display: grid;
  grid-template-columns: 48rem;
  align-content: center;
  justify-content: center;
  gap: 3.2rem;
  background-color: var(--color-grey-50);
`;

function GameSomething2() {
  return <Something2/>
}

export default GameSomething2;
