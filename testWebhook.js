const axios = require("axios");

async function testWebhook() {
  const data = {
    unit: "元/吨",
    avgPrice: 20310,
    change: 100,
    date: "2024-05-21",
    name: "A00铝",
    priceRange: "20290-20330"
  };

  try {
    await axios.post(
      'https://o0squm2ngqo-dev7.aedev.feishuapp.cn/ae/api/v1/automation/namespaces/package_0e79a5__c/events/http/automation_e0ad7046117',
      data,
      {
        headers: {
          'Authorization': 'Bearer 6117b376493',
          'Content-Type': 'application/json'
        }
      }
    );
    console.log('✅ webhook 测试消息已发送');
  } catch (e) {
    console.error('❌ webhook 测试失败:', e.message);
  }
}

testWebhook();