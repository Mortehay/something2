import { Outlet } from "react-router-dom";
import Header from "./Header";
import Sidebar from "./Sidebar";
import styled from "styled-components";

const StyledAppLayout = styled.div`
    display: grid;
    height:100vh;
    grid-template-columns: 26rem 1fr;
    grid-template-rows: auto 1fr;
`;

// Flush scroll container. No padding and no max-width wrapper: the game canvas
// fills this cell edge to edge, and every admin panel already applies its own
// padding + max-width + margin:0 auto. min-height:0 lets the grid cell actually
// shrink -- without it the row refuses to be smaller than its content and the
// page grows a second scrollbar. overflow:auto (not scroll) hides the bar when
// nothing overflows.
const Main = styled.main`
    background-color: var(--color-grey-50);
    min-height: 0;
    overflow: auto;
`;

function AppLayout() {
    return (
        <StyledAppLayout>
            <Header/>
            <Sidebar/>
            <Main>
                <Outlet/>
            </Main>
        </StyledAppLayout>
    )
}

export default AppLayout