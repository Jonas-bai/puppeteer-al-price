# 设置变量
$serverIP = "192.168.11.194"
$remotePath = "/home/user/puppeteer-al-price"
$localPath = "."

# 创建远程目录
Write-Host "Creating remote directory..."
ssh "user@$serverIP" "mkdir -p $remotePath"

# 复制文件到服务器
Write-Host "Copying files to server..."
scp -r "$localPath/*" "user@$serverIP`:$remotePath/"

# 在服务器上执行部署命令
Write-Host "Deploying on server..."
ssh "user@$serverIP" "cd $remotePath && docker-compose down && docker-compose up --build -d"

Write-Host "Deployment completed!" 