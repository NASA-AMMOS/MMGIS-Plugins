const Sequelize = require("sequelize");
const { sequelize } = require(require("path").join(process.cwd(), "API/connection"));

const AgentTool = sequelize.define(
  "agent_tools",
  {
    name: {
      type: Sequelize.STRING,
      primaryKey: true,
      allowNull: false,
    },
    description: {
      type: Sequelize.TEXT,
      allowNull: true,
    },
    execution: {
      type: Sequelize.JSONB,
      allowNull: true,
      defaultValue: {},
    },
    modelParameters: {
      type: Sequelize.JSONB,
      allowNull: true,
      defaultValue: {},
    },
    parameters: {
      type: Sequelize.JSONB,
      allowNull: true,
      defaultValue: {},
    },
    source: {
      type: Sequelize.STRING,
      allowNull: false,
      defaultValue: "api",
    },
    enabled: {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
  },
  {
    timestamps: true,
  },
);

module.exports = AgentTool;
