// HGhub 网页版 PM2 部署配置
module.exports = {
  apps: [
    {
      name: 'hghub-web',
      script: 'server.js',
      cwd: '/root/hghub-web',
      env: {
        PORT: '3020',
        UPSTREAM: 'https://huangguoai.com',
        STATIC_DIR: '/root/hghub-web/dist',
      },
    },
  ],
};
