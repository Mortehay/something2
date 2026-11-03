import Heading from "../ui/Heading";
import Row from "../ui/Row";
import DashboardLayout from "../features/dashboard/DashboardLayout";
import { t } from "../games/something2/src/js/i18n/i18n.js";
import { useLang } from "../games/something2/src/js/i18n/useLang.js";


function Dashboard() {
  useLang();
  return (
    <>
      <Row type="horizontal">
        <Heading as="h1">{t("Dashboard")}</Heading>
      </Row>
      <DashboardLayout />
    </>
  );
}

export default Dashboard;
